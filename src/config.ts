import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig, DatabaseConfig, DatabaseType } from "./types.js";

export const CONFIG_ENV = "DATABASE_CLI_CONFIG";
export const DEFAULT_CONFIG_PATH = join(homedir(), ".database-cli", "config.json");

const SUPPORTED_TYPES = new Set<DatabaseType>(["mysql", "postgres", "redis", "oracle", "mongodb"]);

export function resolveConfigPath(): string {
  return process.env[CONFIG_ENV] || DEFAULT_CONFIG_PATH;
}

export async function loadConfig(path = resolveConfigPath()): Promise<AppConfig> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as AppConfig;
  validateConfig(parsed);
  return parsed;
}

export function validateConfig(config: AppConfig): void {
  if (!config || typeof config !== "object" || !config.databases || typeof config.databases !== "object") {
    throw new Error("配置文件必须包含 databases 对象");
  }

  for (const [name, db] of Object.entries(config.databases)) {
    validateDatabaseConfig(name, db);
  }
}

function validateDatabaseConfig(name: string, db: DatabaseConfig): void {
  if (!db || typeof db !== "object") {
    throw new Error(`数据库配置 ${name} 必须是对象`);
  }
  if (!SUPPORTED_TYPES.has(db.type)) {
    throw new Error(`数据库配置 ${name} 的 type 不受支持: ${String(db.type)}`);
  }
  if (!db.url || typeof db.url !== "string") {
    throw new Error(`数据库配置 ${name} 必须提供 url`);
  }
  if (db.blacklist && !Array.isArray(db.blacklist)) {
    throw new Error(`数据库配置 ${name} 的 blacklist 必须是数组`);
  }
  if (db.keepAliveSeconds !== undefined && (!Number.isInteger(db.keepAliveSeconds) || db.keepAliveSeconds <= 0)) {
    throw new Error(`数据库配置 ${name} 的 keepAliveSeconds 必须是正整数`);
  }
  if (db.oracleDriver !== undefined) {
    if (db.type !== "oracle") {
      throw new Error(`数据库配置 ${name} 只有 oracle 类型允许配置 oracleDriver`);
    }
    if (db.oracleDriver !== "oracledb" && db.oracleDriver !== "sqlcl") {
      throw new Error(`数据库配置 ${name} 的 oracleDriver 只支持 oracledb 或 sqlcl`);
    }
  }
  if (db.sqlclPath !== undefined && typeof db.sqlclPath !== "string") {
    throw new Error(`数据库配置 ${name} 的 sqlclPath 必须是字符串`);
  }
  if (db.javaHome !== undefined && typeof db.javaHome !== "string") {
    throw new Error(`数据库配置 ${name} 的 javaHome 必须是字符串`);
  }
}

export function getDatabaseConfig(config: AppConfig, name: string): DatabaseConfig {
  const db = config.databases[name];
  if (!db) {
    throw new Error(`未找到数据库配置: ${name}`);
  }
  return db;
}

export function listSupportedDatabases(): DatabaseType[] {
  return ["mysql", "postgres", "redis", "oracle", "mongodb"];
}
