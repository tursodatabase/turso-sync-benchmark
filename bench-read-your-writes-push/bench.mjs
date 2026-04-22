#!/usr/bin/env node
// Read-Your-Writes with push every cycle — 200 write→read cycles.
//
// Fair variant: both sides hit the network on every write.
//
// Embedded Replicas: readYourWrites=true, so execute(INSERT) sends to
//   remote + auto-pulls. Then execute(SELECT) reads locally.
//
// @tursodatabase/sync: stmt.run(INSERT) writes locally, then push()
//   sends to remote. Then stmt.get(SELECT) reads locally.
//
// Both pay one network round trip per cycle.

import { createClient } from "@libsql/client";
import { connect } from "@tursodatabase/sync";
import { TOKEN, DB_URL, DDL, cleanLocal, genRow, measure, compare, reportLatencies } from "../shared/utils.mjs";

const N = 200;

async function main() {
  console.log(`\nRead-Your-Writes (push every cycle) — ${N} write→read cycles\n`);

  const remote = createClient({ url: DB_URL, authToken: TOKEN });

  // ── Embedded Replicas ──────────────────────────────────────
  await remote.execute("DROP TABLE IF EXISTS bench");
  await remote.execute(DDL);

  cleanLocal("er.db");
  const er = createClient({
    url: "file:./er.db",
    syncUrl: DB_URL,
    authToken: TOKEN,
    // readYourWrites defaults to true — execute() auto-pulls after writes
  });
  await er.sync();

  const r1 = await measure("Embedded Replicas (write→read, auto-pull)", async () => {
    const lats = [];
    for (let i = 0; i < N; i++) {
      const t = performance.now();
      const row = genRow(i);
      await er.execute({
        sql: "INSERT INTO bench (name, email, bio, score) VALUES (?, ?, ?, ?)",
        args: row,
      });
      const res = await er.execute({
        sql: "SELECT * FROM bench WHERE name = ?",
        args: [row[0]],
      });
      lats.push(performance.now() - t);
      if (!res.rows.length) throw new Error(`Read-your-write failed at i=${i}`);
    }
    reportLatencies("ER write→read cycle", lats);
  });
  er.close();

  // ── @tursodatabase/sync ────────────────────────────────────
  await remote.execute("DROP TABLE IF EXISTS bench");
  await remote.execute(DDL);

  cleanLocal("ts.db");
  const db = await connect({ path: "./ts.db", url: DB_URL, authToken: TOKEN });
  await db.connect();
  await db.pull();

  const r2 = await measure("@tursodatabase/sync (write→push→read per cycle)", async () => {
    const ins = db.prepare(
      "INSERT INTO bench (name, email, bio, score) VALUES (?, ?, ?, ?)"
    );
    const sel = db.prepare("SELECT * FROM bench WHERE name = ?");
    const lats = [];
    for (let i = 0; i < N; i++) {
      const t = performance.now();
      const row = genRow(i);
      await ins.run(...row);
      await db.push();
      const got = await sel.get(row[0]);
      lats.push(performance.now() - t);
      if (!got) throw new Error(`Read-your-write failed at i=${i}`);
    }
    reportLatencies("sync write→push→read cycle", lats);
  });
  await db.close();
  remote.close();

  compare(r1, r2);
}

main().catch(e => { console.error(e); process.exit(1); });
