# Changelog

## Unreleased

- Breaking: removed the local connection daemon. Every command now opens a direct connection, runs, and disconnects. Removed the `daemon` subcommand, the `reset` subcommand (it only dropped a pooled connection), and the now-unused `keepAliveSeconds` config field (existing configs that still set it are ignored). The `repl` subcommand keeps its speed by reusing a single connection for the whole stdin stream, and the MCP server now invokes the CLI binary directly instead of talking to a daemon socket.
- Bugfix: PostgreSQL results now serialize `numeric` (as a precision-preserving string), `date`/`time`/`timestamp`/`timestamptz`, `uuid`, `json`/`jsonb`, `int2`/`float4`, and enum / user-defined text types. These previously came back as the literal string `<unsupported>`.
- Bugfix: error messages now include the full driver error chain, so a failed query reports the real database message (e.g. `db error: ERROR: column "x" does not exist`) instead of just `db error`.

## 0.2.22

- New feature: added an MCP server (`agent-database-cli-mcp`, stdio-based). It runs as a persistent, stateful session: set the active database context with `use_database`, then run `query` / `describe` against the current context, with each tool call going straight to the resident daemon's named pipe (~1-2ms, no per-call process spawn). It exposes the `list_databases`, `use_database`, `query`, `describe`, and `current_context` tools, and auto-starts the daemon if it isn't running. Best suited for agents that query continuously and switch databases on the fly.
- New feature: added a `repl` subcommand that reads SQL line by line from stdin and executes it while reusing the same process and daemon connection, emitting JSON per line. The process startup cost is paid only once, so a single query stays around 0.6-2ms (versus ~20ms when `exec` spawns a new process each time, roughly 16x faster). Ideal for agents that run large numbers of queries back to back.
- Performance: cache the keyword regex used by the safety check. Previously `has_blacklisted_keyword` recompiled the regex on every command, and a read-only SELECT compiled each of the ~16 write keywords once, so a single exec spent about 28ms on regex compilation alone. With process-level caching, a single daemon round trip dropped from about 28.5ms to about 0.86ms, and a process-level exec dropped from about 45ms to about 20ms.
- Performance: removed the Node.js startup overhead from the hot path. During installation, `postinstall` rewrites the launcher shim to call the platform's native binary directly, cutting pure startup time from about 74ms to 27ms; `bin/agent-database-cli.js` is kept as a fallback for cases like `--ignore-scripts`.
- Performance: `run_via_daemon` no longer probes with `is_daemon_running` before each command; instead it sends the request directly and only starts the daemon and retries once if the transport fails. This reduces the hot path from two round trips to one, lowering warm query time from about 99ms to 50ms.
- Bugfix: the daemon now detaches from the launcher at startup (Windows clears the standard-handle inheritance flags plus `DETACHED_PROCESS`, Unix uses `setsid`), avoiding a cold-start case where the caller hangs on a pipe read (such as `out=$(agent-database-cli ...)`) until the daemon exits on idle.

## 0.2.19

- Security: plaintext passwords in database URLs, SSH tunnel passwords, and private-key passphrases are now automatically migrated to local encrypted storage the first time a connection is used, leaving only `passwordRef` / `passphraseRef` in the config file.
- Compatibility: the entry point for re-encrypting retained plaintext fields is preserved, so re-entering a plaintext password overwrites the old ciphertext on next use.

## 0.2.18

- Bugfix: `daemon status` now returns a clear not-running status when the daemon is not running or a stale Unix socket remains, instead of surfacing `Connection refused` directly.

## 0.2.17

- Performance: daemon database requests no longer hold the global config lock; they are serialized per database connection instead, so a slow query on one database does not block others.
- Stability: when the daemon initializes a given database connection for the first time, it adds an initialization placeholder to avoid concurrent cold starts repeatedly creating the SSH tunnel and database connection.
- Security: Redis key metadata queries now read in batches with `SCAN` instead of the blocking `KEYS`; the Redis `KEYS` command is rejected in read-only mode.
- Security: read-only mode additionally rejects queries with write semantics such as PostgreSQL `SELECT INTO`, a CTE followed by a write operation, and MongoDB aggregate `$out` / `$merge`.
- Usability: when the daemon returns an empty response, it now returns a clear error message instead of exposing the underlying `EOF while parsing a value`.
- Quality: cleaned up redundant code patterns flagged by clippy, keeping `cargo fmt`, `cargo test`, and `cargo clippy --all-targets -- -D warnings` passing.

## 0.2.16

- Bugfix: fixed the Windows daemon named-pipe client and server not being implemented, which prevented commands like `test`, `exec`, `meta`, `reset`, and `daemon status` from working correctly through the local daemon.
