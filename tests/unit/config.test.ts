import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG_PATH, resolveConfigPath, validateConfig } from "../../src/config.js";

describe("config", () => {
  it("默认读取 ~/.agent-database-cli/config.json", () => {
    vi.stubEnv("AGENT_DATABASE_CLI_CONFIG", "");
    expect(resolveConfigPath()).toBe(DEFAULT_CONFIG_PATH);
    vi.unstubAllEnvs();
  });

  it("允许环境变量覆盖配置路径", () => {
    vi.stubEnv("AGENT_DATABASE_CLI_CONFIG", "/tmp/agent-database-cli.json");
    expect(resolveConfigPath()).toBe("/tmp/agent-database-cli.json");
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

  it("只允许 Redis 配置 redisCluster", () => {
    expect(() =>
      validateConfig({
        databases: {
          bad: {
            type: "mysql",
            url: "mysql://u:p@localhost/db",
            // @ts-expect-error 测试运行时校验
            redisCluster: {
              nodes: ["redis://127.0.0.1:7001"]
            }
          }
        }
      })
    ).toThrow("只有 redis 类型允许配置 redisCluster");
  });

  it("允许 Redis 集群配置", () => {
    expect(() =>
      validateConfig({
        databases: {
          cluster: {
            type: "redis",
            url: "redis://127.0.0.1:7001",
            redisCluster: {
              nodes: ["redis://127.0.0.1:7001", "redis://127.0.0.1:7002"]
            }
          }
        }
      })
    ).not.toThrow();
  });

  it("允许 Redis 集群与 SSH 隧道同时配置", () => {
    expect(() =>
      validateConfig({
        databases: {
          cluster: {
            type: "redis",
            url: "redis://192.0.2.10:6373",
            redisCluster: {
              nodes: ["redis://192.0.2.10:6373", "redis://192.0.2.11:6373"]
            },
            sshTunnel: {
              host: "jump.example.com",
              username: "deploy",
              privateKeyPath: "~/.ssh/id_rsa"
            }
          }
        }
      })
    ).not.toThrow();
  });

  it("允许配置 SSH 隧道密码认证", () => {
    expect(() =>
      validateConfig({
        databases: {
          mysql: {
            type: "mysql",
            url: "mysql://u:p@db.internal/app",
            sshTunnel: {
              host: "jump.example.com",
              username: "deploy",
              password: "secret"
            }
          }
        }
      })
    ).not.toThrow();
  });

  it("允许配置 SSH 隧道密码加私钥认证", () => {
    expect(() =>
      validateConfig({
        databases: {
          mysql: {
            type: "mysql",
            url: "mysql://u:p@db.internal/app",
            sshTunnel: {
              host: "jump.example.com",
              username: "deploy",
              password: "secret",
              privateKeyPath: "~/.ssh/id_rsa",
              passphrase: "key-secret"
            }
          }
        }
      })
    ).not.toThrow();
  });

  it("拒绝缺少认证方式的 SSH 隧道配置", () => {
    expect(() =>
      validateConfig({
        databases: {
          mysql: {
            type: "mysql",
            url: "mysql://u:p@db.internal/app",
            sshTunnel: {
              host: "jump.example.com",
              username: "deploy"
            }
          }
        }
      })
    ).toThrow("必须配置 password、privateKeyPath 或 privateKey");
  });

  it("拒绝没有私钥的 passphrase 配置", () => {
    expect(() =>
      validateConfig({
        databases: {
          mysql: {
            type: "mysql",
            url: "mysql://u:p@db.internal/app",
            sshTunnel: {
              host: "jump.example.com",
              username: "deploy",
              password: "secret",
              passphrase: "key-secret"
            }
          }
        }
      })
    ).toThrow("passphrase 只能和私钥一起使用");
  });
});
