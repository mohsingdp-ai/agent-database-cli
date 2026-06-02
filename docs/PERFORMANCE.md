# Performance

`agent-database-cli` is optimized at several layers for the high-frequency query workloads typical of agents. This document explains the measured latency of each command, the principles behind the optimizations, and how to get the lowest latency in your own setup.

## Measured latency (Windows, local Postgres, hot path)

| Approach | Per query | Notes |
| --- | --- | --- |
| Early (Node shim + old binary) | ~119 ms | Pre-optimization baseline |
| `exec` (new process each time) | ~19 ms | One-off command; the floor is the OS process-creation cost |
| `repl` (resident process reading stdin) | **~0.6 ms** | Process starts once, executes line by line |
| MCP (`agent-database-cli-mcp`) | **~1.7 ms** | Persistent session + active database context |
| Raw daemon round trip (no process startup) | ~0.86 ms | Named pipe + connection-pool query |

## Core principle: move fixed costs off the "per query" path

```
Slow: start heavy process ──► rebuild DB connection ──► recompute every time ──► run query
Fast: [resident client] ──► [reused connection pool] ──► [cached computation] ──► run query
      (startup paid once)    (connection paid once)    (compiled once)
```

In order of impact, largest to smallest:

1. **Don't spawn a new process for every query.** A one-off shell command pays the OS process-creation cost every time (about 5-15 ms on Windows, unavoidable). To go faster, let a **single resident process** serve many queries: `repl` or the MCP server.
2. **A resident daemon reuses expensive state.** Establishing a database connection (TCP / authentication / SSH tunnel) is costly; the local daemon keeps connections resident, so a single query carries no reconnection cost.
3. **Cache computations that repeat on every request.** The key optimization: the safety check for read-only SQL previously **recompiled the regex every time** for about 16 write keywords, so a single exec spent about 28 ms on regex compilation alone. With process-level caching, a daemon round trip dropped from about 28.5 ms to about 0.86 ms.
4. **Move heavy runtimes / large footprints off the hot path.** The Node launcher cost about 145 ms just to forward; it has been changed to call the native binary directly via `postinstall`.
5. **Reduce round trips.** Removing the `is_daemon_running` probe before each command (two round trips → one) lowered the native hot path from about 99 ms to about 50 ms.
6. **Background processes must not block the caller.** The daemon detaches from the caller at startup (Windows clears standard-handle inheritance; Unix `setsid`), avoiding a pipe read hanging on cold start.

> The order is always "measure first, then decompose." This project's biggest cost (regex compilation) was completely invisible before measurement, while the IPC itself is only 0.37 ms.

## How to go fastest

- **One-off query**: `agent-database-cli exec --db <name> --command "<sql>"` (about 19 ms).
- **Many queries in a row (scripts / pipelines)**: use `repl` and feed multiple SQL statements to a single process:
  ```bash
  printf 'select 1\nselect count(*) from accounts\n' | agent-database-cli repl --db <name>
  ```
  About 0.6 ms each.
- **Agent that queries continuously and switches databases on the fly**: use the MCP server `agent-database-cli-mcp`. `use_database` sets the active context, `query` / `describe` run against the current database, each call takes about 1.7 ms, and there is no per-call process spawn.

`repl` and MCP are two **parallel** clients of the daemon: MCP does not call `repl`; each independently reaches sub-millisecond latency by reusing a "resident process + warm daemon."
