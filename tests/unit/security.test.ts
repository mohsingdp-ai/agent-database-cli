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

  it("SQL 黑名单按完整关键字匹配，避免字段名子串误判", () => {
    expect(() =>
      assertCommandAllowed(
        {
          type: "oracle",
          url: "oracle://user:pass@localhost:1521/FREEPDB1",
          readonly: true,
          blacklist: ["create"]
        },
        "select FCREATETIME from AUDIO where FAUDIOSTATUS in (-1, 0)"
      )
    ).not.toThrow();
  });

  it("SQL 黑名单忽略字符串字面量里的关键字", () => {
    expect(() =>
      assertCommandAllowed(
        {
          type: "oracle",
          url: "oracle://user:pass@localhost:1521/FREEPDB1",
          readonly: true,
          blacklist: ["create"]
        },
        "select 'create' as keyword from dual"
      )
    ).not.toThrow();
  });

  it("SQL 黑名单忽略注释和引用标识符里的关键字", () => {
    expect(() =>
      assertCommandAllowed(
        {
          type: "mysql",
          url: "mysql://user:pass@localhost/db",
          readonly: true,
          blacklist: ["create"]
        },
        "select `create` from audit_log -- create table ignored"
      )
    ).not.toThrow();
  });

  it("SQL 黑名单仍拒绝语句中的高危关键字", () => {
    expect(() =>
      assertCommandAllowed(
        {
          type: "mysql",
          url: "mysql://user:pass@localhost/db",
          readonly: true,
          blacklist: ["create"]
        },
        "select 1; create table audit_log(id int)"
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

  it("未配置 readonly 时默认拒绝写命令", () => {
    expect(() =>
      assertCommandAllowed(
        {
          type: "mysql",
          url: "mysql://user:pass@localhost/db"
        },
        "insert into users(id) values (1)"
      )
    ).toThrow(SecurityError);
  });

  it("显式关闭 readonly 后允许写命令", () => {
    expect(() =>
      assertCommandAllowed(
        {
          type: "mysql",
          url: "mysql://user:pass@localhost/db",
          readonly: false
        },
        "insert into users(id) values (1)"
      )
    ).not.toThrow();
  });
});
