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

  // 默认开启只读，只有显式配置 readonly: false 才允许写操作。
  if (isReadonlyEnabled(config) && !isReadOnlyCommand(config.type, normalized)) {
    throw new SecurityError(`只读模式拒绝执行命令: ${head || normalized}`);
  }
}

function assertNotBlacklisted(config: DatabaseConfig, normalized: string, head: string): void {
  const commandForBlacklist = isSqlDatabase(config.type) ? stripSqlLiteralsAndComments(normalized) : normalized;
  for (const item of config.blacklist || []) {
    const black = normalizeCommand(item).toLowerCase();
    if (!black) {
      continue;
    }
    if (head === black || hasBlacklistedKeyword(commandForBlacklist, black)) {
      throw new SecurityError(`黑名单拒绝执行命令: ${item}`);
    }
  }
}

function hasBlacklistedKeyword(command: string, keyword: string): boolean {
  const normalized = command.toLowerCase();
  const escaped = escapeRegExp(keyword).replace(/\s+/g, "\\s+");
  // 黑名单按完整命令关键字匹配，避免 FCREATETIME 这类字段名误命中 create。
  return new RegExp(`(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])`, "u").test(normalized);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripSqlLiteralsAndComments(command: string): string {
  let result = "";
  let index = 0;

  while (index < command.length) {
    const char = command[index];
    const next = command[index + 1];

    if ((char === "q" || char === "Q") && next === "'") {
      const endIndex = findOracleQuotedLiteralEnd(command, index);
      if (endIndex !== -1) {
        result += " ".repeat(endIndex - index);
        index = endIndex;
        continue;
      }
    }

    if (char === "-" && next === "-") {
      const endIndex = findLineEnd(command, index + 2);
      result += " ".repeat(endIndex - index);
      index = endIndex;
      continue;
    }

    if (char === "#") {
      const endIndex = findLineEnd(command, index + 1);
      result += " ".repeat(endIndex - index);
      index = endIndex;
      continue;
    }

    if (char === "/" && next === "*") {
      const endIndex = findBlockCommentEnd(command, index + 2);
      result += " ".repeat(endIndex - index);
      index = endIndex;
      continue;
    }

    if (char === "'") {
      const endIndex = findQuotedTokenEnd(command, index, "'", "'");
      result += " ".repeat(endIndex - index);
      index = endIndex;
      continue;
    }

    if (char === '"') {
      const endIndex = findQuotedTokenEnd(command, index, '"', '"');
      result += " ".repeat(endIndex - index);
      index = endIndex;
      continue;
    }

    if (char === "`") {
      const endIndex = findQuotedTokenEnd(command, index, "`", "`");
      result += " ".repeat(endIndex - index);
      index = endIndex;
      continue;
    }

    if (char === "[") {
      const endIndex = findQuotedTokenEnd(command, index, "[", "]");
      result += " ".repeat(endIndex - index);
      index = endIndex;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

function findLineEnd(command: string, start: number): number {
  const lineEnd = command.indexOf("\n", start);
  return lineEnd === -1 ? command.length : lineEnd;
}

function findBlockCommentEnd(command: string, start: number): number {
  const commentEnd = command.indexOf("*/", start);
  return commentEnd === -1 ? command.length : commentEnd + 2;
}

function findQuotedTokenEnd(command: string, start: number, open: string, close: string): number {
  let index = start + open.length;
  while (index < command.length) {
    if (command[index] === close) {
      if (command[index + close.length] === close) {
        index += close.length * 2;
        continue;
      }
      return index + close.length;
    }
    if (command[index] === "\\" && close !== "]") {
      index += 2;
      continue;
    }
    index += 1;
  }
  return command.length;
}

function findOracleQuotedLiteralEnd(command: string, start: number): number {
  const open = command[start + 2];
  if (!open) {
    return -1;
  }
  const close = getOracleQuotedLiteralClose(open);
  const closeSequence = `${close}'`;
  const contentStart = start + 3;
  const closeIndex = command.indexOf(closeSequence, contentStart);
  return closeIndex === -1 ? -1 : closeIndex + closeSequence.length;
}

function getOracleQuotedLiteralClose(open: string): string {
  if (open === "[") {
    return "]";
  }
  if (open === "(") {
    return ")";
  }
  if (open === "{") {
    return "}";
  }
  if (open === "<") {
    return ">";
  }
  return open;
}

function isSqlDatabase(type: DatabaseType): boolean {
  return type === "mysql" || type === "postgres" || type === "oracle";
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

function isReadonlyEnabled(config: DatabaseConfig): boolean {
  return config.readonly !== false;
}

function getMongoCommandName(command: string): string {
  const parsed = JSON.parse(command) as Record<string, unknown>;
  const firstKey = Object.keys(parsed)[0];
  if (!firstKey) {
    throw new SecurityError("MongoDB 命令 JSON 不能为空");
  }
  return firstKey;
}
