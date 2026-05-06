export type DatabaseType = "mysql" | "postgres" | "redis" | "oracle" | "mongodb";

export type OutputFormat = "json" | "table";

export interface DatabaseConfig {
  type: DatabaseType;
  url: string;
  redisCluster?: RedisClusterConfig;
  sshTunnel?: SshTunnelConfig;
  database?: string;
  oracleDriver?: "oracledb" | "sqlcl";
  sqlclPath?: string;
  javaHome?: string;
  readonly?: boolean;
  blacklist?: string[];
  keepAliveSeconds?: number;
}

export interface RedisClusterConfig {
  nodes: string[];
}

export interface RedisClusterConnectionConfig {
  nodes: string[];
  nodeAddressMap?: Record<string, RedisNodeAddress>;
}

export interface RedisNodeAddress {
  host: string;
  port: number;
}

export interface SshTunnelConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  privateKey?: string;
  passphrase?: string;
  readyTimeout?: number;
}

export interface AppConfig {
  databases: Record<string, DatabaseConfig>;
}

export interface MetadataRequest {
  type: "tables" | "columns" | "collections" | "keys";
  table?: string;
  pattern?: string;
}

export interface QueryResult {
  rows: unknown[];
  fields?: string[];
  rowCount?: number;
}

export interface DatabaseAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  test(): Promise<void>;
  execute(command: string): Promise<QueryResult>;
  metadata(request: MetadataRequest): Promise<QueryResult>;
}

export type DaemonAction = "test" | "execute" | "metadata" | "reset" | "status" | "stop";

export interface DaemonRequest {
  action: DaemonAction;
  db?: string;
  command?: string;
  metadata?: MetadataRequest;
  configPath?: string;
}

export interface DaemonResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}
