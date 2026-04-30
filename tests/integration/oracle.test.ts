import { describe, expect, it } from "vitest";
import { runExecute, runMetadata, runTest } from "../../src/runtime.js";

describe("oracle integration", () => {
  it("Oracle 支持 test/exec/meta", async () => {
    await expect(runTest("local-oracle")).resolves.toBeTruthy();
    await expect(runExecute("local-oracle", "select 1 from dual")).resolves.toBeTruthy();
    await expect(runMetadata("local-oracle", { type: "tables" })).resolves.toBeTruthy();
  });
});
