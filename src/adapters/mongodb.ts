import { MongoClient, type Db } from "mongodb";
import type { DatabaseAdapter, MetadataRequest, QueryResult } from "../types.js";

export class MongoDbAdapter implements DatabaseAdapter {
  private client?: MongoClient;
  private db?: Db;

  constructor(
    private readonly url: string,
    private readonly database?: string
  ) {}

  async connect(): Promise<void> {
    if (!this.client) {
      this.client = new MongoClient(this.url);
      await this.client.connect();
      this.db = this.client.db(this.database);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = undefined;
      this.db = undefined;
    }
  }

  async test(): Promise<void> {
    await this.connect();
    await this.db!.command({ ping: 1 });
  }

  async execute(command: string): Promise<QueryResult> {
    await this.connect();
    const parsed = JSON.parse(command) as Record<string, unknown>;
    const [operation, payload] = Object.entries(parsed)[0] ?? [];
    if (!operation) {
      throw new Error("MongoDB 命令 JSON 不能为空");
    }
    const rows = await this.runOperation(operation, payload);
    return { rows, rowCount: rows.length };
  }

  async metadata(request: MetadataRequest): Promise<QueryResult> {
    if (request.type !== "collections") {
      throw new Error(`MongoDB 不支持元信息类型: ${request.type}`);
    }
    await this.connect();
    const collections = await this.db!.listCollections().toArray();
    return {
      rows: collections.map((collection) => ({ name: collection.name, type: collection.type })),
      fields: ["name", "type"],
      rowCount: collections.length
    };
  }

  private async runOperation(operation: string, payload: unknown): Promise<unknown[]> {
    const request = normalizeMongoPayload(payload);
    const collection = this.db!.collection(request.collection);
    switch (operation) {
      case "find":
        return collection.find(request.filter, { projection: request.projection }).limit(request.limit ?? 100).toArray();
      case "findOne": {
        const row = await collection.findOne(request.filter, { projection: request.projection });
        return row ? [row] : [];
      }
      case "aggregate":
        return collection.aggregate(request.pipeline ?? []).limit(request.limit ?? 100).toArray();
      case "count":
      case "countDocuments": {
        const count = await collection.countDocuments(request.filter);
        return [{ count }];
      }
      case "estimatedDocumentCount": {
        const count = await collection.estimatedDocumentCount();
        return [{ count }];
      }
      case "distinct": {
        if (!request.field) {
          throw new Error("distinct 命令必须提供 field");
        }
        const values = await collection.distinct(request.field, request.filter);
        return values.map((value) => ({ value }));
      }
      default:
        throw new Error(`不支持的 MongoDB 命令: ${operation}`);
    }
  }
}

interface MongoPayload {
  collection: string;
  filter: Record<string, unknown>;
  projection?: Record<string, unknown>;
  pipeline?: Record<string, unknown>[];
  limit?: number;
  field?: string;
}

function normalizeMongoPayload(payload: unknown): MongoPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("MongoDB 命令必须是对象");
  }
  const value = payload as Partial<MongoPayload>;
  if (!value.collection || typeof value.collection !== "string") {
    throw new Error("MongoDB 命令必须提供 collection");
  }
  return {
    collection: value.collection,
    filter: value.filter ?? {},
    projection: value.projection,
    pipeline: value.pipeline,
    limit: value.limit,
    field: value.field
  };
}
