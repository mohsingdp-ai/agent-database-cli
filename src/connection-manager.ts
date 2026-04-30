import type { AppConfig, DatabaseAdapter, DatabaseConfig, MetadataRequest, QueryResult } from "./types.js";
import { getDatabaseConfig } from "./config.js";
import { assertCommandAllowed } from "./security.js";
import { createAdapter } from "./adapters/factory.js";

interface Entry {
  adapter: DatabaseAdapter;
  config: DatabaseConfig;
  timer?: NodeJS.Timeout;
}

export class ConnectionManager {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly config: AppConfig) {}

  async test(name: string): Promise<{ ok: true }> {
    const entry = await this.getEntry(name);
    await entry.adapter.test();
    this.touch(name, entry);
    return { ok: true };
  }

  async execute(name: string, command: string): Promise<QueryResult> {
    const entry = await this.getEntry(name);
    assertCommandAllowed(entry.config, command);
    const result = await entry.adapter.execute(command);
    this.touch(name, entry);
    return result;
  }

  async metadata(name: string, request: MetadataRequest): Promise<QueryResult> {
    const entry = await this.getEntry(name);
    const result = await entry.adapter.metadata(request);
    this.touch(name, entry);
    return result;
  }

  async reset(name: string): Promise<{ reset: string }> {
    const entry = this.entries.get(name);
    if (entry) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      await entry.adapter.disconnect();
      this.entries.delete(name);
    }
    return { reset: name };
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((name) => this.reset(name)));
  }

  status(): { connections: Array<{ name: string; type: string; keepAliveSeconds: number }> } {
    return {
      connections: [...this.entries.entries()].map(([name, entry]) => ({
        name,
        type: entry.config.type,
        keepAliveSeconds: entry.config.keepAliveSeconds ?? 180
      }))
    };
  }

  private async getEntry(name: string): Promise<Entry> {
    const existing = this.entries.get(name);
    if (existing) {
      return existing;
    }

    const config = getDatabaseConfig(this.config, name);
    const adapter = createAdapter(config);
    await adapter.connect();
    const entry = { adapter, config };
    this.entries.set(name, entry);
    this.touch(name, entry);
    return entry;
  }

  private touch(name: string, entry: Entry): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    const keepAliveSeconds = entry.config.keepAliveSeconds ?? 180;
    entry.timer = setTimeout(() => {
      void this.reset(name);
    }, keepAliveSeconds * 1000);
    entry.timer.unref();
  }
}
