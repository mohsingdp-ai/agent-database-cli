import type { DatabaseConfig, DatabaseType } from "./types.js";

const SQL_READ_COMMANDS = new Set(["select", "show", "describe", "desc", "explain", "with"]);
const REDIS_READ_COMMANDS = new Set([
  "get",
  "mget",
  "exists",
  "ttl",
  "pttl",
  "type",
  "strlen",
  "keys",
  "scan",
  "hget",
  "hgetall",
  "hmget",
  "hexists",
  "hlen",
  "hkeys",
  "hvals",
  "lrange",
  "llen",
  "lindex",
  "smembers",
  "scard",
  "sismember",
  "zrange",
  "zrevrange",
  "zcard",
  "zscore"
]);
const MONGO_READ_COMMANDS = new Set([
  "find",
  "findOne",
  "aggregate",
  "count",
  "countDocuments",
  "estimatedDocumentCount",
  "distinct"
]);

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
  }
}

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

export function getCommandHead(command: string, type: DatabaseType): string {
  const normalized = normalizeCommand(command);
  if (type === "mongodb") {
    return getMongoCommandName(normalized).toLowerCase();
  }
  return normalized.split(/\s+/)[0]?.replace(/;$/, "").toLowerCase() || "";
}

export function assertCommandAllowed(config: DatabaseConfig, command: string): void {
  const normalized = normalizeCommand(command);
  const head = getCommandHead(normalized, config.type);
  assertNotBlacklisted(config, normalized, head);

  if (config.readonly && !isReadOnlyCommand(config.type, normalized)) {
    throw new SecurityError(`只读模式拒绝执行命令: ${head || normalized}`);
  }
}

function assertNotBlacklisted(config: DatabaseConfig, normalized: string, head: string): void {
  for (const item of config.blacklist || []) {
    const black = normalizeCommand(item).toLowerCase();
    if (!black) {
      continue;
    }
    if (head === black || normalized.toLowerCase().includes(black)) {
      throw new SecurityError(`黑名单拒绝执行命令: ${item}`);
    }
  }
}

export function isReadOnlyCommand(type: DatabaseType, command: string): boolean {
  const head = getCommandHead(command, type);
  if (type === "redis") {
    return REDIS_READ_COMMANDS.has(head);
  }
  if (type === "mongodb") {
    return MONGO_READ_COMMANDS.has(getMongoCommandName(command));
  }
  return SQL_READ_COMMANDS.has(head);
}

function getMongoCommandName(command: string): string {
  const parsed = JSON.parse(command) as Record<string, unknown>;
  const firstKey = Object.keys(parsed)[0];
  if (!firstKey) {
    throw new SecurityError("MongoDB 命令 JSON 不能为空");
  }
  return firstKey;
}
