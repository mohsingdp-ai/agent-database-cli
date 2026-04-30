import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDaemonRunning, sendDaemonRequest } from "./client.js";
import { PID_PATH, SOCKET_PATH } from "./paths.js";

export async function startDaemon(): Promise<{ started: boolean; socket: string }> {
  if (await isDaemonRunning()) {
    return { started: false, socket: SOCKET_PATH };
  }

  await mkdir(dirname(SOCKET_PATH), { recursive: true });
  const currentFile = fileURLToPath(import.meta.url);
  const daemonFile = resolve(dirname(currentFile), "server.js");
  const child = spawn(process.execPath, [daemonFile], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();

  for (let i = 0; i < 30; i += 1) {
    await delay(100);
    if (await isDaemonRunning()) {
      return { started: true, socket: SOCKET_PATH };
    }
  }
  throw new Error("daemon 启动超时");
}

export async function stopDaemon(): Promise<{ stopped: boolean }> {
  const response = await sendDaemonRequest({ action: "stop" });
  if (!response.ok) {
    throw new Error(response.error || "daemon 停止失败");
  }
  return { stopped: true };
}

export async function daemonStatus(): Promise<unknown> {
  const response = await sendDaemonRequest({ action: "status" });
  if (!response.ok) {
    throw new Error(response.error || "daemon 状态查询失败");
  }
  return response.data;
}

export async function readPidFile(): Promise<string | undefined> {
  try {
    return (await readFile(PID_PATH, "utf8")).trim();
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
