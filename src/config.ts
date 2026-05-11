import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig, DatabaseConfig, DatabaseType } from "./types.js";

export const CONFIG_ENV = "AGENT_DATABASE_CLI_CONFIG";
export const DEFAULT_CONFIG_PATH = join(homedir(), ".agent-database-cli", "config.json");

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
  if (db.redisCluster !== undefined) {
    validateRedisClusterConfig(name, db);
  }
  if (db.blacklist && !Array.isArray(db.blacklist)) {
    throw new Error(`数据库配置 ${name} 的 blacklist 必须是数组`);
  }
  if (db.keepAliveSeconds !== undefined && (!Number.isInteger(db.keepAliveSeconds) || db.keepAliveSeconds <= 0)) {
    throw new Error(`数据库配置 ${name} 的 keepAliveSeconds 必须是正整数`);
  }
  if (db.sshTunnel !== undefined) {
    validateSshTunnelConfig(name, db.sshTunnel);
  }
  if (db.oracleDriver !== undefined) {
    if (db.type !== "oracle") {
      throw new Error(`数据库配置 ${name} 只有 oracle 类型允许配置 oracleDriver`);
    }
    if (db.oracleDriver !== "oracle" && db.oracleDriver !== "oracledb" && db.oracleDriver !== "sqlcl") {
      throw new Error(`数据库配置 ${name} 的 oracleDriver 只支持 oracle、oracledb 或 sqlcl`);
    }
  }
  if (db.sqlclPath !== undefined && typeof db.sqlclPath !== "string") {
    throw new Error(`数据库配置 ${name} 的 sqlclPath 必须是字符串`);
  }
  if (db.javaHome !== undefined && typeof db.javaHome !== "string") {
    throw new Error(`数据库配置 ${name} 的 javaHome 必须是字符串`);
  }
}

function validateRedisClusterConfig(name: string, db: DatabaseConfig): void {
  if (db.type !== "redis") {
    throw new Error(`数据库配置 ${name} 只有 redis 类型允许配置 redisCluster`);
  }
  if (!db.redisCluster || typeof db.redisCluster !== "object") {
    throw new Error(`数据库配置 ${name} 的 redisCluster 必须是对象`);
  }
  if (!Array.isArray(db.redisCluster.nodes) || db.redisCluster.nodes.length === 0) {
    throw new Error(`数据库配置 ${name} 的 redisCluster.nodes 必须是非空数组`);
  }

  for (const [index, node] of db.redisCluster.nodes.entries()) {
    if (typeof node !== "string" || node.trim() === "") {
      throw new Error(`数据库配置 ${name} 的 redisCluster.nodes[${index}] 必须是非空字符串`);
    }
    validateRedisNodeUrl(name, node, index);
  }

}

function validateRedisNodeUrl(name: string, url: string, index: number): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`数据库配置 ${name} 的 redisCluster.nodes[${index}] 不是合法 URL`);
  }

  if (!["redis:", "rediss:"].includes(parsed.protocol)) {
    throw new Error(`数据库配置 ${name} 的 redisCluster.nodes[${index}] 只支持 redis:// 或 rediss://`);
  }
}

function validateSshTunnelConfig(name: string, tunnel: DatabaseConfig["sshTunnel"]): void {
  if (!tunnel || typeof tunnel !== "object") {
    throw new Error(`数据库配置 ${name} 的 sshTunnel 必须是对象`);
  }
  if (!tunnel.host || typeof tunnel.host !== "string") {
    throw new Error(`数据库配置 ${name} 的 sshTunnel.host 必须是非空字符串`);
  }
  if (tunnel.port !== undefined && (!Number.isInteger(tunnel.port) || tunnel.port <= 0 || tunnel.port > 65535)) {
    throw new Error(`数据库配置 ${name} 的 sshTunnel.port 必须是 1-65535 的整数`);
  }
  if (!tunnel.username || typeof tunnel.username !== "string") {
    throw new Error(`数据库配置 ${name} 的 sshTunnel.username 必须是非空字符串`);
  }
  if (tunnel.password !== undefined && typeof tunnel.password !== "string") {
    throw new Error(`数据库配置 ${name} 的 sshTunnel.password 必须是字符串`);
  }
  if (tunnel.password === "") {
    throw new Error(`数据库配置 ${name} 的 sshTunnel.password 不能为空字符串`);
  }
  if (tunnel.privateKeyPath !== undefined && typeof tunnel.privateKeyPath !== "string") {
    throw new Error(`数据库配置 ${name} 的 sshTunnel.privateKeyPath 必须是字符串`);
  }
  if (tunnel.privateKeyPath === "") {
    throw new Error(`数据库配置 ${name} 的 sshTunnel.privateKeyPath 不能为空字符串`);
  }
  if (tunnel.privateKey !== undefined && typeof tunnel.privateKey !== "string") {
    throw new Error(`数据库配置 ${name} 的 sshTunnel.privateKey 必须是字符串`);
  }
  if (tunnel.privateKey === "") {
    throw new Error(`数据库配置 ${name} 的 sshTunnel.privateKey 不能为空字符串`);
  }
  if (tunnel.privateKeyPath && tunnel.privateKey) {
    throw new Error(`数据库配置 ${name} 的 sshTunnel.privateKeyPath 和 privateKey 只能配置一个`);
  }
  if (!tunnel.password && !tunnel.privateKeyPath && !tunnel.privateKey) {
    throw new Error(`数据库配置 ${name} 的 sshTunnel 必须配置 password、privateKeyPath 或 privateKey`);
  }
  if (tunnel.passphrase !== undefined && typeof tunnel.passphrase !== "string") {
    throw new Error(`数据库配置 ${name} 的 sshTunnel.passphrase 必须是字符串`);
  }
  if (tunnel.passphrase && !tunnel.privateKeyPath && !tunnel.privateKey) {
    throw new Error(`数据库配置 ${name} 的 sshTunnel.passphrase 只能和私钥一起使用`);
  }
  if (tunnel.readyTimeout !== undefined && (!Number.isInteger(tunnel.readyTimeout) || tunnel.readyTimeout <= 0)) {
    throw new Error(`数据库配置 ${name} 的 sshTunnel.readyTimeout 必须是正整数`);
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
