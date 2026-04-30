import { describe, expect, it } from "vitest";
import { runExecute, runMetadata, runTest } from "../../src/runtime.js";

describe("sql integration", () => {
  it("MySQL 支持 test/exec/meta", async () => {
    await expect(runTest("local-mysql")).resolves.toBeTruthy();
    await expect(runExecute("local-mysql", "select 1 as value")).resolves.toMatchObject({ rowCount: 1 });
    await expect(runMetadata("local-mysql", { type: "tables" })).resolves.toBeTruthy();
    await expect(runMetadata("local-mysql", { type: "columns", table: "users" })).resolves.toBeTruthy();
  });

  it("PostgreSQL 支持 test/exec/meta", async () => {
    await expect(runTest("local-postgres")).resolves.toBeTruthy();
    await expect(runExecute("local-postgres", "select 1 as value")).resolves.toMatchObject({ rowCount: 1 });
    await expect(runMetadata("local-postgres", { type: "tables" })).resolves.toBeTruthy();
    await expect(runMetadata("local-postgres", { type: "columns", table: "users" })).resolves.toBeTruthy();
  });
});
