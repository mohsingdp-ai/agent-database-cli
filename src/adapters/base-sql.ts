import type { DatabaseAdapter, MetadataRequest, QueryResult } from "../types.js";

export abstract class BaseSqlAdapter implements DatabaseAdapter {
  protected connected = false;

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract execute(command: string): Promise<QueryResult>;
  protected abstract listTables(): Promise<QueryResult>;
  protected abstract listColumns(table: string): Promise<QueryResult>;

  async test(): Promise<void> {
    await this.execute(this.testQuery());
  }

  async metadata(request: MetadataRequest): Promise<QueryResult> {
    if (request.type === "tables") {
      return this.listTables();
    }
    if (request.type === "columns") {
      if (!request.table) {
        throw new Error("columns 元信息查询必须提供 --table");
      }
      return this.listColumns(request.table);
    }
    throw new Error(`当前数据库不支持元信息类型: ${request.type}`);
  }

  protected testQuery(): string {
    return "select 1";
  }
}
