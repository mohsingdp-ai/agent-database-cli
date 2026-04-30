import mysql, { type Connection } from "mysql2/promise";
import { BaseSqlAdapter } from "./base-sql.js";
import type { QueryResult } from "../types.js";

export class MySqlAdapter extends BaseSqlAdapter {
  private connection?: Connection;

  constructor(private readonly url: string) {
    super();
  }

  async connect(): Promise<void> {
    if (!this.connection) {
      this.connection = await mysql.createConnection(this.url);
    }
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.end();
      this.connection = undefined;
    }
  }

  async execute(command: string): Promise<QueryResult> {
    await this.connect();
    const [rows, fields] = await this.connection!.query(command);
    const normalizedRows = Array.isArray(rows) ? rows : [];
    return {
      rows: normalizedRows as unknown[],
      fields: Array.isArray(fields) ? fields.map((field) => field.name) : undefined,
      rowCount: normalizedRows.length
    };
  }

  protected async listTables(): Promise<QueryResult> {
    return this.execute("show tables");
  }

  protected async listColumns(table: string): Promise<QueryResult> {
    return this.execute(`show columns from \`${table.replace(/`/g, "``")}\``);
  }
}
