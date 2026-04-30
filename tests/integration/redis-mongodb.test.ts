import { describe, expect, it } from "vitest";
import { runExecute, runMetadata, runTest } from "../../src/runtime.js";

describe("redis and mongodb integration", () => {
  it("Redis 支持 test/exec/meta 和黑名单", async () => {
    await expect(runTest("local-redis")).resolves.toBeTruthy();
    await expect(runExecute("local-redis", "SET user:1 alice")).resolves.toBeTruthy();
    await expect(runExecute("local-redis", "GET user:1")).resolves.toBeTruthy();
    await expect(runMetadata("local-redis", { type: "keys", pattern: "user:*" })).resolves.toBeTruthy();
    await expect(runExecute("local-redis", "FLUSHALL")).rejects.toThrow("黑名单");
  });

  it("MongoDB 支持 test/exec/meta", async () => {
    await expect(runTest("local-mongodb")).resolves.toBeTruthy();
    await expect(
      runExecute("local-mongodb", '{"find":{"collection":"users","filter":{},"limit":1}}')
    ).resolves.toBeTruthy();
    await expect(runMetadata("local-mongodb", { type: "collections" })).resolves.toBeTruthy();
  });
});
