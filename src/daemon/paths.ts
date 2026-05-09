import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const RUNTIME_DIR = join(homedir(), ".agent-database-cli");
export const SOCKET_PATH = resolveSocketPath(process.platform, homedir());
export const PID_PATH = join(RUNTIME_DIR, "agent-database-cli.pid");

export function resolveSocketPath(platform: NodeJS.Platform, homeDir: string): string {
  if (platform === "win32") {
    // Windows IPC 必须使用 named pipe，不能使用 Unix socket 文件路径。
    const suffix = createHash("sha1").update(homeDir).digest("hex").slice(0, 12);
    return `\\\\.\\pipe\\agent-database-cli-${suffix}`;
  }
  return join(homeDir, ".agent-database-cli", "agent-database-cli.sock");
}

export function isWindowsNamedPipe(path: string): boolean {
  return path.startsWith("\\\\.\\pipe\\");
}
