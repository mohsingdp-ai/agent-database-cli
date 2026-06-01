# CLI Launch Latency: Before / After

**Type:** Refactoring (Before/After) Flow Diagram
**Last Updated:** 2026-06-01
**Related Files:**
- `bin/agent-database-cli.js` (Node launcher — kept as fallback)
- `bin/postinstall.js` (rewrites launcher shims to call the native binary directly)
- `rust/src/runtime.rs` (`run_via_daemon` — removed per-call daemon probe)
- `rust/src/daemon/control.rs` (`detach_command` — daemon no longer holds caller's stdio)
- `scripts/bench-launch.ps1` (latency + correctness gate)

## Purpose

An AI agent issues many short database commands in a row, so every millisecond of
per-command startup is felt as sluggishness. This change makes each command return
roughly 3x faster and removes a cold-start hang that could freeze an agent's pipeline.

## Diagram

### Before — every command pays Node startup + a redundant probe

```mermaid
graph TD
    subgraph "Front-Stage (User Experience)"
        User[Agent runs a command] --> Wait[Waits ~200-500 ms ⏱️ feels sluggish]
        Wait --> Result[JSON result]
    end

    subgraph "Back-Stage (Implementation)"
        User --> Node[Node.js launcher 🐢 ~150 ms boot just to dispatch]
        Node --> Spawn[spawnSync native binary]
        Spawn --> Probe[is_daemon_running probe 🐢 extra round-trip every call]
        Probe --> Send[Send real request to daemon]
        Send --> DB[(Pooled DB connection 💾 warm, fast)]
    end

    DB --> Result
    User -->|Cold start, stdout piped| Hang[Daemon inherits caller's pipe 🔄 caller hangs until idle-exit]
```

### After — native launch, single round-trip, clean detach

```mermaid
graph TD
    subgraph "Front-Stage (User Experience)"
        User[Agent runs a command] --> Wait[Waits ~70-100 ms ⚡ snappy]
        Wait --> Result[JSON result]
    end

    subgraph "Back-Stage (Implementation)"
        User --> Shim[Native shim ⚡ no Node on hot path ~150 ms saved]
        Shim --> Send[Send request to daemon directly ⚡ no probe]
        Send -->|reachable| DB[(Pooled DB connection 💾 warm, fast)]
        Send -->|not reachable| Start[Start daemon, retry once 🔄 only on cold start]
        Start --> DB
    end

    DB --> Result
    User -->|Cold start, stdout piped| Detach[Daemon detached: DETACHED_PROCESS / setsid 🛡️ caller never hangs]
    Detach --> Result

    style Shim fill:#90EE90
    style Send fill:#90EE90
    style Detach fill:#90EE90
```

## Key Insights

- **Snappier agents (⚡):** Removing Node from the launch path saves ~150 ms per call; the
  warm path also drops a redundant daemon probe (one round-trip instead of two).
- **No more freezes (🛡️/🔄):** Detaching the spawned daemon means a piped caller
  (`out=$(agent-database-cli ...)`) gets EOF immediately on a cold start instead of hanging
  until the daemon idle-exits.
- **Safe fallback (🔄):** The Node launcher remains the linked `bin`, so `--ignore-scripts`
  installs and unusual layouts still work — just at the original speed.
- **Technical enabler:** Connection pooling in the daemon already made the DB round-trip
  cheap; this change removes the *process and protocol* overhead that was dominating it.

## Change History

- **2026-06-01:** Initial creation — documents the launch-latency optimization
  (Node-free shim, single round-trip, daemon detach).
