# Performance

`agent-database-cli` opens a **direct connection per command**: each invocation spawns the process, connects to the database, runs the statement, and disconnects. There is no background daemon and no connection pool. This document explains where the time goes and how to get the lowest latency for high-frequency (agent) workloads.

## Measured latency (Windows, local Postgres over TLS, `passwordRef` credential)

Numbers are environment-specific — they depend on your OS, where the database lives, and whether the connection uses TLS / an SSH tunnel. Measure your own setup with `scripts/bench-launch.ps1`.

| Approach | Latency | What it pays for |
| --- | --- | --- |
| `list` (no DB connection) | ~28 ms | Process spawn + config load only |
| `exec` (one-off command) | ~165 ms | Spawn **+ a fresh DB connection** + query + disconnect |
| `repl` — fixed setup | ~220 ms once | Spawn + the one connection it reuses |
| `repl` — per statement after setup | **~0.3 ms** | Just the query over the warm connection |

The headline: for a **single** command, connection establishment (TCP + TLS + auth, plus decrypting the stored credential) dominates — roughly **130 ms** of the ~165 ms `exec` total, versus only ~28 ms for process spawn. Reusing one connection (`repl`) amortizes that fixed cost to near zero per query.

## Core principle: reuse the connection for high-frequency work

```
One-off (exec / MCP call): spawn ─► connect (TCP/TLS/auth) ─► query ─► disconnect
                                    └──────── dominant ───────┘   (paid every call)

Batch (repl):              spawn ─► connect ─► query ─► query ─► query ─► ...
                                    (paid once)        └─ ~0.3 ms each ─┘
```

The single biggest lever is **how many times you establish a connection**. A one-off `exec` (or a single MCP `query`) pays a full connect every time. Feeding many statements through one `repl` process pays it once.

Secondary, already-applied optimizations on the per-command path:

1. **Native launcher.** During install, `postinstall` rewrites the launcher shim to call the platform's native binary directly instead of going through Node, keeping process spawn around tens of milliseconds rather than ~145 ms. `bin/agent-database-cli.js` remains as a fallback (e.g. `--ignore-scripts`).
2. **Cached safety-check regexes.** The read-only / blocklist check compiles its keyword regexes once per process instead of on every command (previously ~28 ms of regex compilation per `exec`). This is now a negligible part of the query path.

## How to go fastest

- **One-off query**: `agent-database-cli exec --db <name> --command "<sql>"`. Simplest; pays a fresh connection each call (~165 ms here, mostly connection setup).
- **Many queries in a row (scripts / pipelines)**: use `repl` and feed multiple statements to a single process so the connection is established once:
  ```bash
  printf 'select 1\nselect count(*) from accounts\n' | agent-database-cli repl --db <name>
  ```
  ~0.3 ms per statement after the one-time setup.
- **Agent that queries continuously**: the MCP server (`agent-database-cli-mcp`) keeps the **session context** (active database via `use_database`) alive, but each `query` / `describe` invokes the CLI binary directly, so it pays a fresh connection per call like `exec`. For tight query loops where latency matters, prefer `repl`.

> Always measure before optimizing. On this project the connection cost — invisible until measured — is now the dominant term for one-off commands; without the daemon it is paid per call rather than amortized across a warm pool. Choose `repl` when that matters.
