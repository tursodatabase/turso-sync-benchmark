#!/usr/bin/env node
// Pull Remote Changes — 5,000 rows, cloud → local.
//
// Data is written to the cloud first, then pulled to a fresh local database.
// This measures the initial sync / hydration scenario.
//
// Embedded Replicas: sync() pulls WAL frames from the primary.
// @tursodatabase/sync: connect() + pull() downloads the database state
//   as physical pages.
//
// Single operation each side — no per-op latency needed.

import { createClient } from "@libsql/client";
import { connect } from "@tursodatabase/sync";
import { TOKEN, DB_URL, DDL, cleanLocal, genRow, measure, compare } from "../shared/utils.mjs";

const N = 5000;

async function main() {
  console.log(`\nPull Remote Changes — ${N} rows\n`);

  const remote = createClient({ url: DB_URL, authToken: TOKEN });

  // Seed data to remote
  await remote.execute("DROP TABLE IF EXISTS bench");
  await remote.execute(DDL);
  console.log(`  Seeding ${N} rows to remote...`);
  for (let s = 0; s < N; s += 500) {
    const batch = [];
    for (let i = s; i < Math.min(s + 500, N); i++) {
      batch.push({
        sql: "INSERT INTO bench (name, email, bio, score) VALUES (?, ?, ?, ?)",
        args: genRow(i),
      });
    }
    await remote.batch(batch, "write");
  }
  console.log(`  Done.\n`);

  // ── Embedded Replicas ──────────────────────────────────────
  cleanLocal("er.db");
  const er = createClient({
    url: "file:./er.db",
    syncUrl: DB_URL,
    authToken: TOKEN,
  });

  const r1 = await measure("Embedded Replicas (sync)", async () => {
    await er.sync();
    const cnt = await er.execute("SELECT count(*) as c FROM bench");
    return { rowsSynced: cnt.rows[0].c };
  });
  er.close();

  // ── @tursodatabase/sync ────────────────────────────────────
  cleanLocal("ts.db");

  const r2 = await measure("@tursodatabase/sync (connect + pull)", async () => {
    const db = await connect({ path: "./ts.db", url: DB_URL, authToken: TOKEN });
    await db.connect();
    await db.pull();
    const cnt = await db.prepare("SELECT count(*) as c FROM bench").get();
    const ret = { rowsSynced: cnt.c };
    await db.close();
    return ret;
  });
  remote.close();

  compare(r1, r2);
}

main().catch(e => { console.error(e); process.exit(1); });
