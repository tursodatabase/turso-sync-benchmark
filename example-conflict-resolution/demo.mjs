#!/usr/bin/env node
// Conflict Resolution Demo — Three scenarios with @tursodatabase/sync
//
// Demonstrates multi-writer conflict resolution using the CDC-based
// push/pull protocol. Run all three scenarios:
//   node example-conflict-resolution/demo.mjs
//
// Or run a single scenario:
//   node example-conflict-resolution/demo.mjs 1
//   node example-conflict-resolution/demo.mjs 2
//   node example-conflict-resolution/demo.mjs 3

import { connect } from "@tursodatabase/sync";
import { createClient } from "@libsql/client";
import { TOKEN, DB_URL, cleanLocal } from "../shared/utils.mjs";

function remote() {
  return createClient({ url: DB_URL, authToken: TOKEN });
}

async function sync(path) {
  cleanLocal(path);
  const db = await connect({ path, url: DB_URL, authToken: TOKEN });
  await db.connect();
  return db;
}

function dump(label, rows) {
  console.log(`    ${label}:`);
  for (const r of Array.isArray(rows) ? rows : [rows]) {
    const entries = Object.entries(r)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
    console.log(`      { ${entries} }`);
  }
}

// ═══════════════════════════════════════════════════════════════
// SCENARIO 1: No Conflicts — Different Rows
// ═══════════════════════════════════════════════════════════════
async function scenario1() {
  console.log(
    "═══════════════════════════════════════════════════════════════"
  );
  console.log(" SCENARIO 1: No Conflicts — Different Rows");
  console.log(" Two clients insert different rows. Both pushes succeed.");
  console.log(
    "═══════════════════════════════════════════════════════════════\n"
  );

  const rc = remote();
  await rc.execute("DROP TABLE IF EXISTS users");
  await rc.execute(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    score REAL DEFAULT 0
  )`);

  const clientA = await sync("./a1.db");
  const clientB = await sync("./b1.db");
  await clientA.pull();
  await clientB.pull();

  // Both clients write locally, different rows.
  // We use explicit IDs to avoid autoincrement collisions —
  // with local-first sync, two clients would both generate id=1.
  console.log("  Client A inserts 'Alice' locally...");
  await clientA
    .prepare("INSERT INTO users (id, name, score) VALUES (?, ?, ?)")
    .run(1001, "Alice", 100);

  console.log("  Client B inserts 'Bob' locally...");
  await clientB
    .prepare("INSERT INTO users (id, name, score) VALUES (?, ?, ?)")
    .run(2001, "Bob", 200);

  // Both push — no conflict because different rows
  await clientA.push();
  console.log("  Client A pushed → success");

  await clientB.push();
  console.log("  Client B pushed → success (different row, no conflict)\n");

  // Both pull to see each other's changes
  await clientA.pull();
  await clientB.pull();

  const rowsA = await clientA
    .prepare("SELECT * FROM users ORDER BY name")
    .all();
  const rowsB = await clientB
    .prepare("SELECT * FROM users ORDER BY name")
    .all();

  dump("Client A sees", rowsA);
  dump("Client B sees", rowsB);
  console.log("\n  ✓ Both clients see all rows. No conflicts.\n");

  await clientA.close();
  await clientB.close();
  rc.close();
}

// ═══════════════════════════════════════════════════════════════
// SCENARIO 2: Same Row, Different Columns — Rebase Resolves
// ═══════════════════════════════════════════════════════════════
async function scenario2() {
  console.log(
    "═══════════════════════════════════════════════════════════════"
  );
  console.log(" SCENARIO 2: Same Row, Different Columns — Rebase Resolves");
  console.log(" Two clients update different columns of the same row.");
  console.log(" pull() rebases local CDC entries on top of server state.");
  console.log(
    "═══════════════════════════════════════════════════════════════\n"
  );

  const rc = remote();
  await rc.execute("DROP TABLE IF EXISTS users");
  await rc.execute(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    score REAL DEFAULT 0,
    bio TEXT DEFAULT ''
  )`);
  await rc.execute(
    "INSERT INTO users (name, score, bio) VALUES ('Charlie', 50, 'Original bio')"
  );

  const clientA = await sync("./a2.db");
  const clientB = await sync("./b2.db");
  await clientA.pull();
  await clientB.pull();

  console.log("  Initial state (both clients):");
  dump(
    "Charlie",
    await clientA
      .prepare("SELECT * FROM users WHERE name='Charlie'")
      .get()
  );

  // A updates score, B updates bio
  await clientA
    .prepare("UPDATE users SET score = ? WHERE name = ?")
    .run(100, "Charlie");
  console.log("\n  Client A updates score → 100 (locally)");

  await clientB
    .prepare("UPDATE users SET bio = ? WHERE name = ?")
    .run("Updated by Client B", "Charlie");
  console.log("  Client B updates bio → 'Updated by Client B' (locally)");

  // A pushes first
  await clientA.push();
  console.log("\n  Client A pushes → success (score=100 on server)");

  // B pushes — succeeds because the UPDATE SET bio=? doesn't conflict
  await clientB.push();
  console.log("  Client B pushes → success (bio updated on server)");

  // B's LOCAL database still doesn't have A's score change.
  const beforePull = await clientB
    .prepare("SELECT * FROM users WHERE name='Charlie'")
    .get();
  console.log("\n  Client B local state BEFORE pull:");
  dump("Charlie", beforePull);
  console.log(
    "    (B has its own bio update, but NOT A's score update)"
  );

  // B pulls — rebase: rolls back B's changes, applies server state,
  // replays B's CDC entries on top
  await clientB.pull();
  const afterPull = await clientB
    .prepare("SELECT * FROM users WHERE name='Charlie'")
    .get();
  console.log("\n  Client B pulls (rebase happens):");
  dump("Charlie", afterPull);

  // A also pulls to get B's bio change
  await clientA.pull();
  const finalA = await clientA
    .prepare("SELECT * FROM users WHERE name='Charlie'")
    .get();
  console.log("\n  Client A pulls:");
  dump("Charlie", finalA);

  console.log("\n  ✓ Both column changes preserved through rebase.\n");

  await clientA.close();
  await clientB.close();
  rc.close();
}

// ═══════════════════════════════════════════════════════════════
// SCENARIO 3: Same Row, Same Column — Manual Resolution
// ═══════════════════════════════════════════════════════════════
async function scenario3() {
  console.log(
    "═══════════════════════════════════════════════════════════════"
  );
  console.log(" SCENARIO 3: Same Row, Same Column — Manual Resolution");
  console.log(
    " Two clients update the same column. Without intervention,"
  );
  console.log(
    " last-push-wins. The transform callback enables custom merge."
  );
  console.log(
    "═══════════════════════════════════════════════════════════════\n"
  );

  const rc = remote();
  await rc.execute("DROP TABLE IF EXISTS users");
  await rc.execute(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    score REAL DEFAULT 0,
    notes TEXT DEFAULT ''
  )`);
  await rc.execute(
    "INSERT INTO users (name, score, notes) VALUES ('Eve', 50, 'initial')"
  );

  // ─── Part A: Show the problem (last-push-wins) ────────────

  console.log("  ── Part A: Without transform (last-push-wins) ──\n");

  const clientA = await sync("./a3a.db");
  const clientB = await sync("./b3a.db");
  await clientA.pull();
  await clientB.pull();

  console.log("  Both clients see: Eve score=50");

  await clientA
    .prepare("UPDATE users SET score = ? WHERE name = ?")
    .run(100, "Eve");
  console.log("  Client A updates score → 100");

  await clientB
    .prepare("UPDATE users SET score = ? WHERE name = ?")
    .run(75, "Eve");
  console.log("  Client B updates score → 75");

  await clientA.push();
  console.log("  Client A pushes → score=100 on server");

  await clientB.push();
  console.log("  Client B pushes → score=75 on server (overwrites A!)");

  await clientA.pull();
  const lost = await clientA
    .prepare("SELECT score FROM users WHERE name='Eve'")
    .get();
  console.log(`\n  Client A pulls: score=${lost.score}`);
  console.log(
    "  ✗ A's update to 100 was silently overwritten by B's 75.\n"
  );

  await clientA.close();
  await clientB.close();

  // ─── Part B: Transform callback resolves the conflict ──────

  console.log("  ── Part B: With transform (conflict-aware merge) ──\n");

  // Reset remote state
  await rc.execute("UPDATE users SET score = 50, notes = 'initial'");

  const clientA2 = await sync("./a3b.db");
  await clientA2.pull();

  // Client B connects with a transform callback.
  // The transform fires during both pull (rebase replay) and push.
  // We only want conflict resolution during push, so we gate on a flag.
  cleanLocal("./b3b.db");
  let isPushing = false;
  const clientB2 = await connect({
    path: "./b3b.db",
    url: DB_URL,
    authToken: TOKEN,
    transform: (mutation) => {
      if (!isPushing) return null; // Only resolve conflicts during push
      if (
        mutation.tableName === "users" &&
        mutation.changeType === "update"
      ) {
        const serverScore = mutation.before?.score;
        const myScore = mutation.after?.score;

        // Detect same-column conflict: server value differs from our value
        if (
          serverScore !== undefined &&
          myScore !== undefined &&
          serverScore !== myScore
        ) {
          const merged = Math.max(serverScore, myScore);
          console.log(
            `    [transform] Conflict on 'score': server=${serverScore}, mine=${myScore} → merged=${merged}`
          );

          return {
            operation: "rewrite",
            stmt: {
              sql: "UPDATE users SET score = ? WHERE id = ?",
              values: [merged, mutation.id],
            },
          };
        }
      }
      return null; // no conflict, keep as-is
    },
  });
  await clientB2.connect();
  await clientB2.pull();

  console.log("  Both clients see: Eve score=50");

  await clientA2
    .prepare("UPDATE users SET score = ? WHERE name = ?")
    .run(100, "Eve");
  console.log("  Client A updates score → 100");

  await clientB2
    .prepare("UPDATE users SET score = ? WHERE name = ?")
    .run(75, "Eve");
  console.log("  Client B updates score → 75");

  // A pushes first
  await clientA2.push();
  console.log("  Client A pushes → score=100 on server");

  // B pulls to rebase — server score=100, B's local intent=75
  await clientB2.pull();
  console.log(
    "  Client B pulls (rebase: server score=100, B's local intent=75)"
  );

  // B pushes — transform callback fires during push
  console.log("  Client B pushes with transform:");
  isPushing = true;
  await clientB2.push();
  isPushing = false;

  // Verify final state
  await clientA2.pull();
  const resolved = await clientA2
    .prepare("SELECT score FROM users WHERE name='Eve'")
    .get();
  console.log(`\n  Final score: ${resolved.score}`);
  console.log(
    "  ✓ Conflict resolved: kept higher score (100). A's change preserved.\n"
  );

  // ─── Part C: Manual resolution without transform ───────────

  console.log("  ── Part C: Manual resolution (inspect + fix) ──\n");

  // Reset
  await rc.execute("UPDATE users SET score = 50, notes = 'initial'");

  const clientA3 = await sync("./a3c.db");
  const clientB3 = await sync("./b3c.db");
  await clientA3.pull();
  await clientB3.pull();

  await clientA3
    .prepare("UPDATE users SET notes = ? WHERE name = ?")
    .run("note from A", "Eve");
  await clientB3
    .prepare("UPDATE users SET notes = ? WHERE name = ?")
    .run("note from B", "Eve");

  await clientA3.push();
  console.log("  Client A pushes: notes='note from A'");

  // B pulls — rebase replays B's change, last-write-wins locally
  await clientB3.pull();
  const afterRebase = await clientB3
    .prepare("SELECT notes FROM users WHERE name='Eve'")
    .get();
  console.log(
    `  Client B pulls. After rebase, notes='${afterRebase.notes}'`
  );
  console.log(
    "  B sees its own value, but A's note was overwritten in the rebase.\n"
  );

  // B manually merges
  const myNote = "note from B";
  const serverNote = "note from A";
  const merged = `${serverNote}\n${myNote}`;

  await clientB3
    .prepare("UPDATE users SET notes = ? WHERE name = ?")
    .run(merged, "Eve");
  console.log("  Client B manually merges notes:");
  console.log(`    Server had: '${serverNote}'`);
  console.log(`    B wanted:   '${myNote}'`);
  console.log(`    Merged:     '${merged}'`);

  await clientB3.push();
  console.log("  Client B pushes merged value.");

  await clientA3.pull();
  const final3 = await clientA3
    .prepare("SELECT notes FROM users WHERE name='Eve'")
    .get();
  console.log(`\n  Final notes: '${final3.notes}'`);
  console.log("  ✓ Both notes preserved through manual merge.\n");

  await clientA3.close();
  await clientB3.close();
  await clientA2.close();
  await clientB2.close();
  rc.close();
}

// ═══════════════════════════════════════════════════════════════

const scenarios = { 1: scenario1, 2: scenario2, 3: scenario3 };

async function main() {
  console.log(
    "╔═══════════════════════════════════════════════════════════════╗"
  );
  console.log(
    "║  @tursodatabase/sync — Conflict Resolution Demo              ║"
  );
  console.log(
    "╚═══════════════════════════════════════════════════════════════╝\n"
  );

  const which = process.argv[2];
  if (which && scenarios[which]) {
    await scenarios[which]();
  } else {
    await scenario1();
    await scenario2();
    await scenario3();
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
