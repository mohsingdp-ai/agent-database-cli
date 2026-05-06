import { describe, expect, it } from "vitest";
import { rewriteDatabaseUrl } from "../../src/ssh-tunnel.js";

describe("ssh tunnel", () => {
  it("重写标准数据库 URL 的 host 和 port", () => {
    expect(rewriteDatabaseUrl("mysql", "mysql://u:p@db.internal:3306/app", "127.0.0.1", 41000)).toBe(
      "mysql://u:p@127.0.0.1:41000/app"
    );
  });

  it("保留查询参数", () => {
    expect(rewriteDatabaseUrl("postgres", "postgres://u:p@db.internal/app?sslmode=disable", "127.0.0.1", 41000)).toBe(
      "postgres://u:p@127.0.0.1:41000/app?sslmode=disable"
    );
  });

  it("支持重写 Redis URL", () => {
    expect(rewriteDatabaseUrl("redis", "redis://192.0.2.10:6373", "127.0.0.1", 41000)).toBe(
      "redis://127.0.0.1:41000"
    );
  });

  it("拒绝 MongoDB 多 host URL", () => {
    expect(() =>
      rewriteDatabaseUrl("mongodb", "mongodb://db1.internal:27017,db2.internal:27017/app", "127.0.0.1", 41000)
    ).toThrow("MongoDB 多 host URL");
  });
});
