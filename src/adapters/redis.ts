import { createClient, createCluster, type RedisClientType, type RedisClusterType } from "redis";
import type {
  DatabaseAdapter,
  MetadataRequest,
  QueryResult,
  RedisClusterConnectionConfig
} from "../types.js";
import { isReadOnlyCommand } from "../security.js";

export class RedisAdapter implements DatabaseAdapter {
  private standaloneClient?: RedisClientType;
  private clusterClient?: RedisClusterType;

  constructor(
    private readonly url: string,
    private readonly redisCluster?: RedisClusterConnectionConfig
  ) {}

  async connect(): Promise<void> {
    if (this.redisCluster) {
      if (!this.clusterClient) {
        this.clusterClient = createCluster({
          rootNodes: [{ url: this.url }],
          nodeAddressMap: this.redisCluster.nodeAddressMap
        });
        await this.clusterClient.connect();
      }
      return;
    }

    if (!this.standaloneClient) {
      this.standaloneClient = createClient({ url: this.url });
      await this.standaloneClient.connect();
    }
  }

  async disconnect(): Promise<void> {
    if (this.clusterClient) {
      await this.clusterClient.quit();
      this.clusterClient = undefined;
    }
    if (this.standaloneClient) {
      await this.standaloneClient.quit();
      this.standaloneClient = undefined;
    }
  }

  async test(): Promise<void> {
    await this.connect();
    await this.executeRawCommand(["PING"], true);
  }

  async execute(command: string): Promise<QueryResult> {
    await this.connect();
    const parts = splitCommand(command);
    const result = await this.executeRawCommand(parts, isReadOnlyCommand("redis", command));
    return { rows: [{ result }], rowCount: 1 };
  }

  async metadata(request: MetadataRequest): Promise<QueryResult> {
    if (request.type !== "keys") {
      throw new Error(`Redis 不支持元信息类型: ${request.type}`);
    }
    await this.connect();
    const pattern = request.pattern || "*";
    const keys = this.clusterClient ? await this.collectClusterKeys(pattern) : await this.standaloneClient!.keys(pattern);
    return { rows: keys.map((key: string) => ({ key })), fields: ["key"], rowCount: keys.length };
  }

  private async executeRawCommand(parts: string[], isReadonly: boolean): Promise<unknown> {
    if (this.clusterClient) {
      const firstKey = getFirstKey(parts);
      return this.clusterClient.sendCommand(firstKey, isReadonly, parts);
    }
    return this.standaloneClient!.sendCommand(parts);
  }

  private async collectClusterKeys(pattern: string): Promise<string[]> {
    const keys = new Set<string>();
    for (const node of this.clusterClient!.masters) {
      const nodeClient = await this.clusterClient!.nodeClient(node);
      const nodeKeys = await nodeClient.keys(pattern);
      for (const key of nodeKeys) {
        keys.add(key);
      }
    }
    return [...keys];
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

function getFirstKey(parts: string[]): string | undefined {
  return parts.length > 1 ? parts[1] : undefined;
}
