import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, mkdtempMock, writeFileMock, rmMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  mkdtempMock: vi.fn(),
  writeFileMock: vi.fn(),
  rmMock: vi.fn()
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock
}));

vi.mock("node:fs/promises", () => ({
  mkdtemp: mkdtempMock,
  writeFile: writeFileMock,
  rm: rmMock
}));

import { OracleSqlclAdapter } from "../../src/adapters/oracle-sqlcl.js";

describe("oracle sqlcl adapter", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    mkdtempMock.mockReset();
    writeFileMock.mockReset();
    rmMock.mockReset();
    mkdtempMock.mockResolvedValue("/tmp/database-cli-sqlcl-test");
    writeFileMock.mockResolvedValue(undefined);
    rmMock.mockResolvedValue(undefined);
  });

  it("解析 SQLcl JSON 查询结果", async () => {
    spawnMock.mockImplementation(() => {
      const script = String(writeFileMock.mock.calls[0]?.[1]);
      const beginMarker = script.match(/__DATABASE_CLI_SQLCL_RESULT_BEGIN_[A-Za-z0-9_]+__/)?.[0];
      const endMarker = script.match(/__DATABASE_CLI_SQLCL_RESULT_END_[A-Za-z0-9_]+__/)?.[0];
      return createChildProcess({
        code: 0,
        stdout: `${[
          beginMarker,
          "{\"results\":[{\"columns\":[{\"name\":\"1\",\"type\":\"NUMBER\"}],\"items\":[{\"1\":1}]}]}",
          endMarker
        ].join("\n")}\n`
      });
    });
    const adapter = new OracleSqlclAdapter("oracle://user:pass@127.0.0.1:1521/FREEPDB1", "/mock/sql", "/mock/java");

    await expect(adapter.execute("select 1 from dual")).resolves.toEqual({
      rows: [{ "1": 1 }],
      fields: ["1"],
      rowCount: 1
    });

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(String(writeFileMock.mock.calls[0]?.[1])).toContain("set sqlformat json");
  });

  it("拒绝多条 SQL 语句", async () => {
    const adapter = new OracleSqlclAdapter("oracle://user:pass@127.0.0.1:1521/FREEPDB1", "/mock/sql", "/mock/java");

    await expect(adapter.execute("select 1 from dual; select 2 from dual")).rejects.toThrow("单条 SQL");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("拒绝 SQLcl 元命令", async () => {
    const adapter = new OracleSqlclAdapter("oracle://user:pass@127.0.0.1:1521/FREEPDB1", "/mock/sql", "/mock/java");

    await expect(adapter.execute("select 1 from dual\nprompt hacked")).rejects.toThrow("SQLcl 元命令");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("临时脚本使用单次随机 marker", async () => {
    spawnMock.mockImplementation(() =>
      createChildProcess({
        code: 0,
        stdout: ""
      })
    );
    const adapter = new OracleSqlclAdapter("oracle://user:pass@127.0.0.1:1521/FREEPDB1", "/mock/sql", "/mock/java");

    await adapter.execute("select 1 from dual");
    await adapter.execute("select 1 from dual");

    const firstScript = String(writeFileMock.mock.calls[0]?.[1]);
    const secondScript = String(writeFileMock.mock.calls[1]?.[1]);
    expect(firstScript).toContain("__DATABASE_CLI_SQLCL_RESULT_BEGIN_");
    expect(secondScript).toContain("__DATABASE_CLI_SQLCL_RESULT_BEGIN_");
    expect(firstScript).not.toBe(secondScript);
  });

  it("命中 SP2 错误时即使退出码为 0 也报错", async () => {
    spawnMock.mockImplementation(() =>
      createChildProcess({
        code: 0,
        stdout: "SP2-0640: Not connected\n"
      })
    );
    const adapter = new OracleSqlclAdapter("oracle://user:pass@127.0.0.1:1521/FREEPDB1", "/mock/sql", "/mock/java");

    await expect(adapter.execute("select 1 from dual")).rejects.toThrow("SP2-0640");
  });
});

function createChildProcess({
  code,
  stdout,
  stderr = ""
}: {
  code: number;
  stdout: string;
  stderr?: string;
}) {
  const processEmitter = new EventEmitter();
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();

  const child = Object.assign(processEmitter, {
    stdout: stdoutEmitter,
    stderr: stderrEmitter
  });

  queueMicrotask(() => {
    if (stdout) {
      stdoutEmitter.emit("data", Buffer.from(stdout, "utf8"));
    }
    if (stderr) {
      stderrEmitter.emit("data", Buffer.from(stderr, "utf8"));
    }
    processEmitter.emit("close", code);
  });

  return child;
}
