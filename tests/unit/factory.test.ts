import { describe, expect, it } from "vitest";
import { createAdapter } from "../../src/adapters/factory.js";

describe("adapter factory", () => {
  it("支持 v1 数据库类型", () => {
    expect(createAdapter({ type: "mysql", url: "mysql://u:p@localhost/db" })).toBeTruthy();
    expect(createAdapter({ type: "postgres", url: "postgres://u:p@localhost/db" })).toBeTruthy();
    expect(createAdapter({ type: "redis", url: "redis://localhost:6379" })).toBeTruthy();
    expect(createAdapter({ type: "oracle", url: "oracle://u:p@localhost:1521/FREEPDB1" })).toBeTruthy();
    expect(
      createAdapter({
        type: "oracle",
        url: "oracle://u:p@localhost:1521/FREEPDB1",
        oracleDriver: "sqlcl",
        sqlclPath: "/tmp/sql"
      })
    ).toBeTruthy();
    expect(createAdapter({ type: "mongodb", url: "mongodb://localhost:27017/app" })).toBeTruthy();
  });

  it("拒绝未知类型", () => {
    expect(() =>
      createAdapter({
        // @ts-expect-error 测试运行时校验
        type: "sqlite",
        url: "sqlite://test.db"
      })
    ).toThrow("不支持");
  });
});
