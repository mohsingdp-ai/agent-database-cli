import type { DatabaseAdapter, DatabaseConfig } from "../types.js";
import { MongoDbAdapter } from "./mongodb.js";
import { MySqlAdapter } from "./mysql.js";
import { OracleAdapter } from "./oracle.js";
import { OracleSqlclAdapter } from "./oracle-sqlcl.js";
import { PostgresAdapter } from "./postgres.js";
import { RedisAdapter } from "./redis.js";

export function createAdapter(config: DatabaseConfig): DatabaseAdapter {
  switch (config.type) {
    case "mysql":
      return new MySqlAdapter(config.url);
    case "postgres":
      return new PostgresAdapter(config.url);
    case "redis":
      return new RedisAdapter(config.url);
    case "oracle":
      if (config.oracleDriver === "sqlcl") {
        return new OracleSqlclAdapter(config.url, config.sqlclPath, config.javaHome);
      }
      return new OracleAdapter(config.url);
    case "mongodb":
      return new MongoDbAdapter(config.url, config.database);
    default:
      throw new Error(`不支持的数据库类型: ${(config as DatabaseConfig).type}`);
  }
}
