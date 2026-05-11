import type { DatabaseAdapter, DatabaseConfig } from "../types.js";
import { MongoDbAdapter } from "./mongodb.js";
import { MySqlAdapter } from "./mysql.js";
import { OracleAdapter } from "./oracle.js";
import { OracleSqlclAdapter } from "./oracle-sqlcl.js";
import { PostgresAdapter } from "./postgres.js";
import { RedisAdapter } from "./redis.js";

export function createAdapter(config: DatabaseConfig, url = config.url): DatabaseAdapter {
  switch (config.type) {
    case "mysql":
      return new MySqlAdapter(url);
    case "postgres":
      return new PostgresAdapter(url);
    case "redis":
      return new RedisAdapter(url, config.redisCluster);
    case "oracle":
      if (config.oracleDriver === "oracledb") {
        return new OracleAdapter(url);
      }
      return new OracleSqlclAdapter(url, config.sqlclPath, config.javaHome);
    case "mongodb":
      return new MongoDbAdapter(url, config.database);
    default:
      throw new Error(`不支持的数据库类型: ${(config as DatabaseConfig).type}`);
  }
}
