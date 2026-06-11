#!/usr/bin/env node
// MCP server for agent-database-cli.
//
// A persistent, stateful session: it holds an "active database" context and
// forwards each tool call to the native CLI binary, which opens a direct
// connection, runs the command, and disconnects. The server process stays alive
// across the whole MCP session and tracks the active database; switch databases
// any time with `use_database`.
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
// Config path (matches the CLI's resolve_config_path)
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
// CLI transport
//
// Each tool call runs the native binary as a one-shot subcommand. The binary
// prints a single JSON document to stdout on success and exits non-zero with a
// message on stderr on failure. There is no background process or socket.
// ---------------------------------------------------------------------------
function runCli(args) {
  const bin = nativeBinary();
  if (!bin) throw new Error("agent-database-cli native binary not found");
  const result = spawnSync(bin, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "command failed").trim()
    );
  }
  const out = (result.stdout || "").trim();
  return out ? JSON.parse(out) : {};
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
      runCli(["test", "--db", database]); // verify connection
      activeDatabase = database;
      return { active: activeDatabase, ok: true };
    }
    case "query": {
      const sql = args?.sql;
      if (!sql) throw new Error("missing parameter: sql");
      return runCli(["exec", "--db", requireActive(), "--command", sql]);
    }
    case "describe": {
      const type = args?.type;
      if (!type) throw new Error("missing parameter: type");
      const cliArgs = ["meta", "--db", requireActive(), "--type", type];
      if (args?.table) cliArgs.push("--table", args.table);
      if (args?.pattern) cliArgs.push("--pattern", args.pattern);
      return runCli(cliArgs);
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
