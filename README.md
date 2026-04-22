# Turso Sync Benchmark

Benchmarks comparing two approaches for syncing data with [Turso](https://turso.tech):

- **Embedded Replicas** (`@libsql/client` with `syncUrl`) — the legacy approach where writes go to the remote and `sync()` pulls changes locally
- **@tursodatabase/sync** — the new push/pull protocol where writes are local and `push()`/`pull()` handle synchronization

## Results

Measured on a Fly.io VM in `us-east-1`, same region as the Turso database.

| Benchmark | Embedded Replicas | @tursodatabase/sync | Speedup | Data Reduction |
|-----------|------------------|---------------------|---------|----------------|
| Sequential Inserts (3,000) | 152s / 34.6 MB | 17s / 2.1 MB | **8.9x** | **16.3x** |
| Batched Inserts (3,000) | 16.5s / 9.2 MB | 14.2s / 2.2 MB | **1.2x** | **4.3x** |
| Read-Your-Writes (200) | 48.6s / 2.7 MB | 0.16s / 149 KB | **312x** | **18.4x** |
| Pull Remote (5,000) | 0.72s / 1.08 MB | 0.34s / 1.05 MB | **2.1x** | **~1x** |
| Sequential Updates (2,000) | 97s / 13.7 MB | 9.3s / 945 KB | **10.5x** | **14.8x** |

## Setup

```bash
npm install
```

Set your Turso credentials:

```bash
export TURSO_DATABASE_URL="libsql://your-db.turso.io"
export TURSO_AUTH_TOKEN="your-token"
```

## Running Benchmarks

Each benchmark is in its own directory and can be run independently:

```bash
# Sequential inserts (3,000 rows)
node bench-sequential-inserts/bench.mjs

# Batched inserts (3,000 rows, push every 500)
node bench-batched-inserts/bench.mjs

# Read-your-writes (200 cycles)
node bench-read-your-writes/bench.mjs

# Pull remote changes (5,000 rows)
node bench-pull-remote/bench.mjs

# Sequential updates (2,000 rows)
node bench-sequential-updates/bench.mjs

# Conflict resolution demo (3 scenarios)
node example-conflict-resolution/demo.mjs

# Or run a single scenario (1, 2, or 3):
node example-conflict-resolution/demo.mjs 2
```

## Network Measurement

Network bytes are measured via `/proc/net/dev` (Linux only). On macOS or other platforms, network stats will show as 0 — only timing will be reported.

## Structure

```
├── shared/
│   └── utils.mjs                    # Common utilities, config, measurement helpers
├── bench-sequential-inserts/
│   └── bench.mjs                    # One INSERT per call
├── bench-batched-inserts/
│   └── bench.mjs                    # Push every 500 rows
├── bench-read-your-writes/
│   └── bench.mjs                    # Write → read cycles
├── bench-pull-remote/
│   └── bench.mjs                    # Cloud → local sync
├── bench-sequential-updates/
│   └── bench.mjs                    # UPDATE existing rows
├── example-conflict-resolution/
│   └── demo.mjs                     # Multi-writer conflict resolution scenarios
└── package.json
```

## License

MIT
