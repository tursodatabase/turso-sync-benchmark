#!/usr/bin/env node
// Read-Your-Writes — 200 write→read cycles.
//
// Embedded Replicas: readYourWrites defaults to true. When enabled, every
//   execute() on a write automatically calls try_pull() under the hood,
//   syncing the local replica before returning. So a cycle is just:
//   execute(INSERT) → execute(SELECT). No manual sync() needed.
//   One network round trip per write (execute sends to remote + auto-pull).
//
// @tursodatabase/sync: Each cycle is: stmt.run(INSERT) → stmt.get(SELECT).
//   Both are local. Zero network round trips. Push happens once at the end.
//
// Per-op latency IS fair here — both measure the same user-visible
// operation: "write a row and read it back." For ER that requires
// network (automatic pull inside execute); for sync it doesn't.

import { createClient } from "@libsql/client";
import { connect } from "@tursodatabase/sync";
import { TOKEN, DB_URL, DDL, cleanLocal, genRow, measure, compare, reportLatencies } from "../shared/utils.mjs";

const N = 200;

async function main() {
  console.log(`\nRead-Your-Writes — ${N} write→read cycles\n`);

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
      // execute(INSERT) sends to remote + auto-pulls (readYourWrites=true)
      await er.execute({
        sql: "INSERT INTO bench (name, email, bio, score) VALUES (?, ?, ?, ?)",
        args: row,
      });
      // No sync() needed — readYourWrites already pulled
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

  const r2 = await measure("@tursodatabase/sync (local write→read, push at end)", async () => {
    const ins = db.prepare(
      "INSERT INTO bench (name, email, bio, score) VALUES (?, ?, ?, ?)"
    );
    const sel = db.prepare("SELECT * FROM bench WHERE name = ?");
    const lats = [];
    for (let i = 0; i < N; i++) {
      const t = performance.now();
      const row = genRow(i);
      await ins.run(...row);
      const got = await sel.get(row[0]);
      lats.push(performance.now() - t);
      if (!got) throw new Error(`Read-your-write failed at i=${i}`);
    }
    const t0 = performance.now();
    await db.push();
    const pushMs = performance.now() - t0;
    reportLatencies("sync write→read cycle", lats);
    console.log(`    push() at end: ${pushMs.toFixed(0)}ms`);
  });
  await db.close();
  remote.close();

  compare(r1, r2);
}

main().catch(e => { console.error(e); process.exit(1); });
