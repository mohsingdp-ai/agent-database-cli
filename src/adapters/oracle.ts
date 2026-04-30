import oracledb, { type Connection } from "oracledb";
import { BaseSqlAdapter } from "./base-sql.js";
import type { QueryResult } from "../types.js";

export class OracleAdapter extends BaseSqlAdapter {
  private connection?: Connection;

  constructor(private readonly url: string) {
    super();
  }

  async connect(): Promise<void> {
    if (this.connection) {
      return;
    }
    const parsed = new URL(this.url);
    this.connection = await oracledb.getConnection({
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      connectString: `${parsed.hostname}:${parsed.port || "1521"}${parsed.pathname}`
    });
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = undefined;
    }
  }

  async execute(command: string): Promise<QueryResult> {
    await this.connect();
    const result = await this.connection!.execute(command, [], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: true });
    return {
      rows: (result.rows ?? []) as unknown[],
      fields: result.metaData?.map((field) => field.name) ?? [],
      rowCount: result.rowsAffected ?? result.rows?.length ?? 0
    };
  }

  protected testQuery(): string {
    return "select 1 from dual";
  }

  protected async listTables(): Promise<QueryResult> {
    return this.execute("select table_name from user_tables order by table_name");
  }

  protected async listColumns(table: string): Promise<QueryResult> {
    const escaped = table.replace(/'/g, "''").toUpperCase();
    return this.execute(
      `select table_name, column_name, data_type from user_tab_columns where table_name = '${escaped}' order by column_id`
    );
  }
}
