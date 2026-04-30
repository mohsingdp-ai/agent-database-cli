export type DatabaseType = "mysql" | "postgres" | "redis" | "oracle" | "mongodb";

export type OutputFormat = "json" | "table";

export interface DatabaseConfig {
  type: DatabaseType;
  url: string;
  database?: string;
  oracleDriver?: "oracledb" | "sqlcl";
  sqlclPath?: string;
  javaHome?: string;
  readonly?: boolean;
  blacklist?: string[];
  keepAliveSeconds?: number;
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
