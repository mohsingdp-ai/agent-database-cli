import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG_PATH, resolveConfigPath, validateConfig } from "../../src/config.js";

describe("config", () => {
  it("默认读取 ~/.database-cli/config.json", () => {
    vi.stubEnv("DATABASE_CLI_CONFIG", "");
    expect(resolveConfigPath()).toBe(DEFAULT_CONFIG_PATH);
    vi.unstubAllEnvs();
  });

  it("允许环境变量覆盖配置路径", () => {
    vi.stubEnv("DATABASE_CLI_CONFIG", "/tmp/database-cli.json");
    expect(resolveConfigPath()).toBe("/tmp/database-cli.json");
    vi.unstubAllEnvs();
  });

  it("拒绝未知数据库类型", () => {
    expect(() =>
      validateConfig({
        databases: {
          bad: {
            // @ts-expect-error 测试运行时校验
            type: "unknown",
            url: "test://localhost"
          }
        }
      })
    ).toThrow("不受支持");
  });

  it("只允许 Oracle 配置 oracleDriver", () => {
    expect(() =>
      validateConfig({
        databases: {
          bad: {
            type: "mysql",
            url: "mysql://u:p@localhost/db",
            oracleDriver: "sqlcl"
          }
        }
      })
    ).toThrow("只有 oracle 类型允许配置 oracleDriver");
  });
});
