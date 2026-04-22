#!/usr/bin/env node
// Sequential Inserts — 3,000 rows, one INSERT per call.
//
// All writes first, one sync/push at the end.
//   ER: N execute() calls (each a remote round trip) + 1 sync().
//   Sync: N stmt.run() calls (local) + 1 push().
//   Shows total throughput for bulk writes.

import { createClient } from "@libsql/client";
import { connect } from "@tursodatabase/sync";
import { TOKEN, DB_URL, DDL, cleanLocal, genRow, measure, compare } from "../shared/utils.mjs";

const N = 3000;

async function main() {
  const remote = createClient({ url: DB_URL, authToken: TOKEN });

  console.log(`\n── Sequential Inserts — ${N} rows ──\n`);

  await remote.execute("DROP TABLE IF EXISTS bench");
  await remote.execute(DDL);

  cleanLocal("er.db");
  const er = createClient({
    url: "file:./er.db",
    syncUrl: DB_URL,
    authToken: TOKEN,
    readYourWrites: false,
  });
  await er.sync();

  const r1 = await measure("Embedded Replicas", async () => {
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      await er.execute({
        sql: "INSERT INTO bench (name, email, bio, score) VALUES (?, ?, ?, ?)",
        args: genRow(i),
      });
    }
    const execMs = performance.now() - t0;
    const t1 = performance.now();
    await er.sync();
    const syncMs = performance.now() - t1;
    console.log(`    Executes: ${(execMs / 1000).toFixed(2)}s (${(execMs / N).toFixed(1)}ms/op) | sync(): ${(syncMs / 1000).toFixed(2)}s`);
  });
  er.close();

  await remote.execute("DROP TABLE IF EXISTS bench");
  await remote.execute(DDL);

  cleanLocal("ts.db");
  const db = await connect({ path: "./ts.db", url: DB_URL, authToken: TOKEN });
  await db.connect();
  await db.pull();

  const r2 = await measure("@tursodatabase/sync", async () => {
    const stmt = db.prepare(
      "INSERT INTO bench (name, email, bio, score) VALUES (?, ?, ?, ?)"
    );
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      await stmt.run(...genRow(i));
    }
    const localMs = performance.now() - t0;
    const t1 = performance.now();
    await db.push();
    const pushMs = performance.now() - t1;
    console.log(`    Local writes: ${(localMs / 1000).toFixed(2)}s | push(): ${(pushMs / 1000).toFixed(2)}s`);
  });
  await db.close();
  remote.close();

  compare(r1, r2);
}

main().catch(e => { console.error(e); process.exit(1); });
