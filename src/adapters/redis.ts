import { createClient, type RedisClientType } from "redis";
import type { DatabaseAdapter, MetadataRequest, QueryResult } from "../types.js";

export class RedisAdapter implements DatabaseAdapter {
  private client?: RedisClientType;

  constructor(private readonly url: string) {}

  async connect(): Promise<void> {
    if (!this.client) {
      this.client = createClient({ url: this.url });
      await this.client.connect();
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = undefined;
    }
  }

  async test(): Promise<void> {
    await this.connect();
    await this.client!.ping();
  }

  async execute(command: string): Promise<QueryResult> {
    await this.connect();
    const parts = splitCommand(command);
    const result = await this.client!.sendCommand(parts);
    return { rows: [{ result }], rowCount: 1 };
  }

  async metadata(request: MetadataRequest): Promise<QueryResult> {
    if (request.type !== "keys") {
      throw new Error(`Redis 不支持元信息类型: ${request.type}`);
    }
    await this.connect();
    const pattern = request.pattern || "*";
    const keys = await this.client!.keys(pattern);
    return { rows: keys.map((key) => ({ key })), fields: ["key"], rowCount: keys.length };
  }
}

function splitCommand(command: string): string[] {
  const matches = command.match(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|\S+/g);
  if (!matches || matches.length === 0) {
    throw new Error("Redis 命令不能为空");
  }
  return matches.map((part) => {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      return part.slice(1, -1);
    }
    return part;
  });
}
