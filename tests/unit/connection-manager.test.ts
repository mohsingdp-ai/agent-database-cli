import { describe, expect, it } from "vitest";
import { ConnectionManager } from "../../src/connection-manager.js";

describe("connection manager", () => {
  it("执行黑名单命令时先做安全校验，不依赖连接成功", async () => {
    const manager = new ConnectionManager({
      databases: {
        redis: {
          type: "redis",
          url: "redis://192.0.2.10:6393",
          readonly: true,
          blacklist: ["set"]
        }
      }
    });

    await expect(manager.execute("redis", "SET user:1 alice")).rejects.toThrow("黑名单");
  });
});
