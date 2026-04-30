import { describe, expect, it } from "vitest";
import { assertCommandAllowed, isReadOnlyCommand, SecurityError } from "../../src/security.js";

describe("security", () => {
  it("黑名单优先于只读模式", () => {
    expect(() =>
      assertCommandAllowed(
        {
          type: "mysql",
          url: "mysql://user:pass@localhost/db",
          readonly: true,
          blacklist: ["drop"]
        },
        "drop table users"
      )
    ).toThrow(/黑名单/);
  });

  it("SQL 只读模式只允许读命令", () => {
    expect(isReadOnlyCommand("mysql", "select * from users")).toBe(true);
    expect(isReadOnlyCommand("postgres", "delete from users")).toBe(false);
  });

  it("Redis 只读模式只允许读命令", () => {
    expect(isReadOnlyCommand("redis", "GET user:1")).toBe(true);
    expect(isReadOnlyCommand("redis", "SET user:1 alice")).toBe(false);
  });

  it("MongoDB 只读模式只允许读命令", () => {
    expect(isReadOnlyCommand("mongodb", '{"find":{"collection":"users"}}')).toBe(true);
    expect(isReadOnlyCommand("mongodb", '{"deleteMany":{"collection":"users"}}')).toBe(false);
  });

  it("只读模式拒绝写命令", () => {
    expect(() =>
      assertCommandAllowed(
        {
          type: "redis",
          url: "redis://localhost:6379",
          readonly: true
        },
        "SET a b"
      )
    ).toThrow(SecurityError);
  });
});
