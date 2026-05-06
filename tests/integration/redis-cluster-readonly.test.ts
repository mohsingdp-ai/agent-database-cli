import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { ConnectionManager } from "../../src/connection-manager.js";

describe("redis cluster readonly integration", () => {
  it("Redis Cluster 只读模式会拦截写命令", async () => {
    const config = await loadConfig("config/docker-test.json");
    const manager = new ConnectionManager(config);

    try {
      await expect(manager.test("qfang-basic-redis-cluster")).rejects.toThrow();
      await expect(manager.execute("qfang-basic-redis-cluster", "SET user:1 alice")).rejects.toThrow("黑名单");
    } finally {
      await manager.closeAll();
    }
  });
});
