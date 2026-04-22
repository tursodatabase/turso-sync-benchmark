// shared/utils.mjs — Common utilities for all benchmarks
import { readFileSync, unlinkSync, readdirSync } from "node:fs";

export const TOKEN = process.env.TURSO_AUTH_TOKEN || readFileSync("/tmp/token.txt", "utf8").trim();
export const DB_URL = process.env.TURSO_DATABASE_URL || "libsql://your-db.turso.io";

export function cleanLocal(prefix) {
  try {
    const base = prefix.replace("./", "");
    for (const f of readdirSync(".")) {
      if (f === base || f.startsWith(base + "-") || f.startsWith(base + ".")) {
        try { unlinkSync(`./${f}`); } catch {}
      }
    }
  } catch {}
}

export function getNetBytes() {
  try {
    const data = readFileSync("/proc/net/dev", "utf8");
    for (const line of data.split("\n")) {
      if (line.trim().startsWith("eth0:")) {
        const parts = line.split(":")[1].trim().split(/\s+/);
        return { rx: parseInt(parts[0]), tx: parseInt(parts[8]) };
      }
    }
  } catch {}
  return { rx: 0, tx: 0 };
}

export function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

export function fmtTime(t) {
  if (t < 1000) return `${t.toFixed(0)}ms`;
  return `${(t / 1000).toFixed(2)}s`;
}

export function genRow(i) {
  return [
    `user_${i}`,
    `user${i}@bench.dev`,
    `Bio for user ${i}: ` + "x".repeat(120) + ` [${Math.random().toString(36).slice(2)}]`,
    Math.random() * 10000,
  ];
}

export const DDL = `CREATE TABLE IF NOT EXISTS bench (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  bio TEXT,
  score REAL
)`;

export async function measure(label, fn) {
  const nb = getNetBytes();
  const t0 = performance.now();
  const extra = await fn();
  const elapsed = performance.now() - t0;
  const na = getNetBytes();
  const rx = na.rx - nb.rx;
  const tx = na.tx - nb.tx;
  const total = rx + tx;

  console.log(`  ${label}`);
  console.log(`    Time:    ${fmtTime(elapsed)}`);
  if (total > 0) {
    console.log(`    Network: ↓${fmt(rx)} ↑${fmt(tx)} = ${fmt(total)}`);
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra))
      console.log(`    ${k}: ${v}`);
  }
  return { label, ms: elapsed, rx, tx, total, ...(extra || {}) };
}

export function percentile(sorted, p) {
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function latencyStats(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    avg: sum / sorted.length,
    p50: percentile(sorted, 50),
    p99: percentile(sorted, 99),
    p999: percentile(sorted, 99.9),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    count: sorted.length,
  };
}

export function reportLatencies(label, latencies) {
  const s = latencyStats(latencies);
  console.log(`    ${label} per-op latency (${s.count} ops):`);
  console.log(`      avg=${fmtTime(s.avg)}  p50=${fmtTime(s.p50)}  p99=${fmtTime(s.p99)}  p999=${fmtTime(s.p999)}`);
  console.log(`      min=${fmtTime(s.min)}  max=${fmtTime(s.max)}`);
  return s;
}

export function compare(r1, r2) {
  const speedup = r1.ms / r2.ms;
  const dataRatio = r1.total && r2.total ? r1.total / r2.total : 0;
  console.log(`\n  → Speed: ${speedup.toFixed(1)}x faster with @tursodatabase/sync`);
  if (dataRatio > 0)
    console.log(`  → Data:  ${dataRatio.toFixed(1)}x less traffic with @tursodatabase/sync`);
  console.log(`\n${JSON.stringify({
    er: { timeMs: Math.round(r1.ms), bytes: r1.total },
    sync: { timeMs: Math.round(r2.ms), bytes: r2.total },
    speedup: parseFloat(speedup.toFixed(1)),
    dataRatio: dataRatio ? parseFloat(dataRatio.toFixed(1)) : null,
  }, null, 2)}`);
}
