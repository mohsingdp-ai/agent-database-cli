import { describe, expect, it } from "vitest";
import { isWindowsNamedPipe, resolveSocketPath } from "../../src/daemon/paths.js";

describe("daemon paths", () => {
  it("Windows 使用 named pipe", () => {
    const socketPath = resolveSocketPath("win32", "C:\\Users\\syy");
    expect(socketPath.startsWith("\\\\.\\pipe\\agent-database-cli-")).toBe(true);
    expect(isWindowsNamedPipe(socketPath)).toBe(true);
  });

  it("非 Windows 使用 Unix socket 文件路径", () => {
    const socketPath = resolveSocketPath("darwin", "/Users/syy");
    expect(socketPath).toBe("/Users/syy/.agent-database-cli/agent-database-cli.sock");
    expect(isWindowsNamedPipe(socketPath)).toBe(false);
  });
});
