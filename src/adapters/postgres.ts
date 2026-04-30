import pg from "pg";
import { BaseSqlAdapter } from "./base-sql.js";
import type { QueryResult } from "../types.js";

const { Client } = pg;

export class PostgresAdapter extends BaseSqlAdapter {
  private client?: pg.Client;

  constructor(private readonly url: string) {
    super();
  }

  async connect(): Promise<void> {
    if (!this.client) {
      this.client = new Client({ connectionString: this.url });
      await this.client.connect();
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.client = undefined;
    }
  }

  async execute(command: string): Promise<QueryResult> {
    await this.connect();
    const result = await this.client!.query(command);
    return {
      rows: result.rows,
      fields: result.fields.map((field) => field.name),
      rowCount: result.rowCount ?? result.rows.length
    };
  }

  protected async listTables(): Promise<QueryResult> {
    return this.execute(
      "select table_schema, table_name from information_schema.tables where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema') order by table_schema, table_name"
    );
  }

  protected async listColumns(table: string): Promise<QueryResult> {
    const escaped = table.replace(/'/g, "''");
    return this.execute(
      `select table_schema, table_name, column_name, data_type from information_schema.columns where table_name = '${escaped}' order by ordinal_position`
    );
  }
}
