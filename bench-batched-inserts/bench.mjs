#!/usr/bin/env node
// Batched Inserts — 3,000 rows, pushed in batches of 500.
//
// Push/sync after every 500 rows.
//   ER: batch(500) per round trip (already goes to remote).
//   Sync: 500 local writes + push() per batch.
//   Per-batch latency with avg/p99/p999.

import { createClient } from "@libsql/client";
import { connect } from "@tursodatabase/sync";
import { TOKEN, DB_URL, DDL, cleanLocal, genRow, measure, compare, reportLatencies } from "../shared/utils.mjs";

const N = 3000;
const BATCH = 500;

async function main() {
  const remote = createClient({ url: DB_URL, authToken: TOKEN });
  const rows = Array.from({ length: N }, (_, i) => genRow(i));

  console.log(`\n── Batched Inserts — ${N} rows, push every ${BATCH} ──\n`);

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

  const r1 = await measure("Embedded Replicas (batch(500) per round trip)", async () => {
    const lats = [];
    for (let start = 0; start < N; start += BATCH) {
      const t = performance.now();
      await er.batch(
        rows.slice(start, start + BATCH).map(r => ({
          sql: "INSERT INTO bench (name, email, bio, score) VALUES (?, ?, ?, ?)",
          args: r,
        })),
        "write"
      );
      lats.push(performance.now() - t);
    }
    reportLatencies("ER batch(500)", lats);
  });
  er.close();

  await remote.execute("DROP TABLE IF EXISTS bench");
  await remote.execute(DDL);

  cleanLocal("ts.db");
  const db = await connect({ path: "./ts.db", url: DB_URL, authToken: TOKEN });
  await db.connect();
  await db.pull();

  const r2 = await measure("@tursodatabase/sync (500 writes + push per batch)", async () => {
    const stmt = db.prepare(
      "INSERT INTO bench (name, email, bio, score) VALUES (?, ?, ?, ?)"
    );
    const lats = [];
    for (let start = 0; start < N; start += BATCH) {
      const t = performance.now();
      for (let i = start; i < Math.min(start + BATCH, N); i++) {
        await stmt.run(...rows[i]);
      }
      await db.push();
      lats.push(performance.now() - t);
    }
    reportLatencies("sync 500 writes + push", lats);
  });
  await db.close();
  remote.close();

  compare(r1, r2);
}

main().catch(e => { console.error(e); process.exit(1); });
