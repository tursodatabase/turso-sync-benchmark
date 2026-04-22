#!/usr/bin/env node
// Sequential Updates — 2,000 rows.
//
// Pre-seed rows in the cloud, pull them locally, then update every row.
// All updates first, one sync/push at the end.
//   ER: N execute(UPDATE) calls (each a remote round trip) + 1 sync().
//   Sync: N stmt.run(UPDATE) calls (local) + 1 push().

import { createClient } from "@libsql/client";
import { connect } from "@tursodatabase/sync";
import { TOKEN, DB_URL, DDL, cleanLocal, genRow, measure, compare } from "../shared/utils.mjs";

const N = 2000;

async function seedRemote(remote, n) {
  for (let s = 0; s < n; s += 500) {
    const batch = [];
    for (let i = s; i < Math.min(s + 500, n); i++) {
      batch.push({
        sql: "INSERT INTO bench (name, email, bio, score) VALUES (?, ?, ?, ?)",
        args: genRow(i),
      });
    }
    await remote.batch(batch, "write");
  }
}

function updateArgs(i) {
  return [
    Math.random() * 99999,
    `Updated bio ${i}: ` + "y".repeat(120),
    i,
  ];
}

async function main() {
  const remote = createClient({ url: DB_URL, authToken: TOKEN });

  console.log(`\n── Sequential Updates — ${N} rows ──\n`);

  await remote.execute("DROP TABLE IF EXISTS bench");
  await remote.execute(DDL);
  await seedRemote(remote, N);

  cleanLocal("er.db");
  const er = createClient({
    url: "file:./er.db",
    syncUrl: DB_URL,
    authToken: TOKEN,
    readYourWrites: false,
  });
  await er.sync();

  const r1 = await measure(`Embedded Replicas (${N} updates)`, async () => {
    const t0 = performance.now();
    for (let i = 1; i <= N; i++) {
      await er.execute({
        sql: "UPDATE bench SET score = ?, bio = ? WHERE id = ?",
        args: updateArgs(i),
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
  await seedRemote(remote, N);

  cleanLocal("ts.db");
  const db = await connect({ path: "./ts.db", url: DB_URL, authToken: TOKEN });
  await db.connect();
  await db.pull();

  const r2 = await measure(`@tursodatabase/sync (${N} updates + push)`, async () => {
    const stmt = db.prepare("UPDATE bench SET score = ?, bio = ? WHERE id = ?");
    const t0 = performance.now();
    for (let i = 1; i <= N; i++) {
      await stmt.run(...updateArgs(i));
    }
    const localMs = performance.now() - t0;
    const t1 = performance.now();
    await db.push();
    const pushMs = performance.now() - t1;
    console.log(`    Local updates: ${(localMs / 1000).toFixed(2)}s | push(): ${(pushMs / 1000).toFixed(2)}s`);
  });
  await db.close();
  remote.close();

  compare(r1, r2);
}

main().catch(e => { console.error(e); process.exit(1); });
