#!/usr/bin/env node
// MCP server for agent-database-cli.
//
// A persistent, stateful session: it holds an "active database" context and
// forwards each tool call to the warm local daemon over its named pipe / unix
// socket. Because the server process stays alive across the whole MCP session,
// there is no per-query process spawn -- each query is just the daemon round
// trip (~1ms). Switch databases any time with `use_database`.
import net from "node:net";
import os from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

const CONFIG_ENV = "AGENT_DATABASE_CLI_CONFIG";

// ---------------------------------------------------------------------------
// Config path (matches the Rust daemon's resolve_config_path)
// ---------------------------------------------------------------------------
function configPath() {
  return (
    process.env[CONFIG_ENV] ||
    join(os.homedir(), ".agent-database-cli", "config.json")
  );
}

// Resolve the native binary (platform sub-package, with repo/dev fallbacks).
function nativeBinary() {
  const byPlatform = {
    "darwin-arm64": "@agent-database-cli/darwin-arm64",
    "darwin-x64": "@agent-database-cli/darwin-x64",
    "linux-x64": "@agent-database-cli/linux-x64",
    "linux-arm64": "@agent-database-cli/linux-arm64",
    "win32-x64": "@agent-database-cli/win32-x64"
  };
  const pkg = byPlatform[`${process.platform}-${process.arch}`];
  const exe =
    process.platform === "win32"
      ? "agent-database-cli.exe"
      : "agent-database-cli";
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..");
  const candidates = [
    pkg && join(root, "..", pkg, "bin", exe),
    pkg && join(root, "node_modules", pkg, "bin", exe),
    join(here, "..", "target", "release", exe),
    join(here, "..", "target", "debug", exe)
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) ?? null;
}

// ---------------------------------------------------------------------------
// Daemon transport
//
// The socket/pipe address is NOT re-derived here. `daemon start` returns the
// authoritative address the daemon actually bound (control.rs), so we use that
// and avoid any cross-language derivation mismatch (Node os.homedir() vs Rust
// dirs::home_dir()).
// ---------------------------------------------------------------------------
function transport(address, request, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(address);
    let buf = "";
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn(arg);
    };
    const timer = setTimeout(
      () => done(reject, new Error("daemon request timed out")),
      timeoutMs
    );
    sock.on("connect", () => sock.write(JSON.stringify(request) + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        try {
          done(resolve, JSON.parse(buf.slice(0, nl)));
        } catch (error) {
          done(reject, error);
        }
      }
    });
    sock.on("error", (error) => done(reject, error));
    sock.on("end", () => done(reject, new Error("daemon connection closed prematurely")));
  });
}

// Start the daemon (idempotent) and learn the authoritative socket address it
// bound. `daemon start` returns {"started":bool,"socket":"..."} on both the
// already-running and just-started paths, and only returns once the daemon is
// reachable, so its address is safe to use immediately.
let socketAddress = null;
function ensureDaemon() {
  const bin = nativeBinary();
  if (!bin) throw new Error("agent-database-cli native binary not found; cannot start daemon");
  const result = spawnSync(bin, ["daemon", "start"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("failed to start daemon: " + (result.stderr || "").trim());
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("could not parse daemon start output: " + result.stdout);
  }
  if (!parsed.socket) throw new Error("daemon start did not return a socket address");
  socketAddress = parsed.socket;
  return socketAddress;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Send a request; on transport failure (re)start the daemon and retry briefly.
async function callDaemon(action, extra = {}) {
  const request = { action, configPath: configPath(), ...extra };
  if (!socketAddress) ensureDaemon();
  try {
    return unwrap(await transport(socketAddress, request));
  } catch (first) {
    ensureDaemon();
    let lastError = first;
    for (let i = 0; i < 20; i += 1) {
      try {
        return unwrap(await transport(socketAddress, request));
      } catch (error) {
        lastError = error;
        await sleep(100);
      }
    }
    throw lastError;
  }
}

function unwrap(response) {
  if (!response.ok) {
    throw new Error(response.error || "daemon execution failed");
  }
  return response.data ?? {};
}

function configuredDatabases() {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    return Object.keys(raw.databases || {});
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Session state: the active database context
// ---------------------------------------------------------------------------
let activeDatabase = null;

function requireActive() {
  if (!activeDatabase) {
    throw new Error("No database selected: call use_database first to set the active database");
  }
  return activeDatabase;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "list_databases",
    description:
      "List configured local database connections and supported database types.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "use_database",
    description:
      "Set the active database context for this session. Subsequent query/describe calls use it until changed.",
    inputSchema: {
      type: "object",
      properties: {
        database: {
          type: "string",
          description: "A configured connection name (see list_databases)."
        }
      },
      required: ["database"],
      additionalProperties: false
    }
  },
  {
    name: "query",
    description:
      "Run a SQL / Redis / MongoDB command against the active database (read-only unless that connection is configured otherwise). Returns rows as JSON.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "The statement to execute." }
      },
      required: ["sql"],
      additionalProperties: false
    }
  },
  {
    name: "describe",
    description:
      "Read metadata for the active database: tables, columns (needs table), collections, or keys (optional pattern).",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["tables", "columns", "collections", "keys"] },
        table: { type: "string" },
        pattern: { type: "string" }
      },
      required: ["type"],
      additionalProperties: false
    }
  },
  {
    name: "current_context",
    description: "Show the currently active database for this session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

async function handleTool(name, args) {
  switch (name) {
    case "list_databases":
      return {
        active: activeDatabase,
        configured: configuredDatabases(),
        supported: ["mysql", "postgres", "redis", "oracle", "mongodb"]
      };
    case "current_context":
      return { active: activeDatabase };
    case "use_database": {
      const database = args?.database;
      if (!database) throw new Error("missing parameter: database");
      const known = configuredDatabases();
      if (known.length && !known.includes(database)) {
        throw new Error(
          `Unknown database "${database}". Available: ${known.join(", ") || "(none)"}`
        );
      }
      await callDaemon("test", { db: database }); // verify connection
      activeDatabase = database;
      return { active: activeDatabase, ok: true };
    }
    case "query": {
      const sql = args?.sql;
      if (!sql) throw new Error("missing parameter: sql");
      return await callDaemon("execute", { db: requireActive(), command: sql });
    }
    case "describe": {
      const type = args?.type;
      if (!type) throw new Error("missing parameter: type");
      return await callDaemon("metadata", {
        db: requireActive(),
        metadata: { type, table: args?.table, pattern: args?.pattern }
      });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Wire up the MCP server
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "agent-database-cli", version: "0.2.22" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const result = await handleTool(req.params.name, req.params.arguments || {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error?.message ?? error}` }],
      isError: true
    };
  }
});

const transportLayer = new StdioServerTransport();
await server.connect(transportLayer);
