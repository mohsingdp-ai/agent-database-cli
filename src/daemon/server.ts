import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { dirname } from "node:path";
import type { DaemonRequest, DaemonResponse } from "../types.js";
import { toErrorMessage } from "../utils/masking.js";
import { DaemonConfigManager } from "./config-manager.js";
import { isWindowsNamedPipe, PID_PATH, SOCKET_PATH } from "./paths.js";

const DAEMON_IDLE_SECONDS = 300;
const configManager = new DaemonConfigManager();
let idleTimer: NodeJS.Timeout | undefined;

async function handleRequest(request: DaemonRequest): Promise<DaemonResponse> {
  if (request.action === "status") {
    return { ok: true, data: configManager.status() };
  }
  if (request.action === "stop") {
    setTimeout(() => {
      void shutdown(0);
    }, 10).unref();
    return { ok: true, data: { stopped: true } };
  }
  if (!request.db) {
    throw new Error("daemon 请求必须提供 db");
  }

  const current = await configManager.getManager(request.configPath);
  if (request.action === "test") {
    return { ok: true, data: await current.test(request.db) };
  }
  if (request.action === "execute") {
    if (!request.command) {
      throw new Error("execute 请求必须提供 command");
    }
    return { ok: true, data: await current.execute(request.db, request.command) };
  }
  if (request.action === "metadata") {
    if (!request.metadata) {
      throw new Error("metadata 请求必须提供 metadata");
    }
    return { ok: true, data: await current.metadata(request.db, request.metadata) };
  }
  if (request.action === "reset") {
    return { ok: true, data: await current.reset(request.db) };
  }
  throw new Error(`不支持的 daemon action: ${request.action}`);
}

async function start(): Promise<void> {
  await mkdir(dirname(PID_PATH), { recursive: true });
  if (!isWindowsNamedPipe(SOCKET_PATH)) {
    await mkdir(dirname(SOCKET_PATH), { recursive: true, mode: 0o700 });
    await chmod(dirname(SOCKET_PATH), 0o700);
    await rm(SOCKET_PATH, { force: true });
  }
  const server = net.createServer((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      if (!input.includes("\n")) {
        return;
      }
      const line = input.slice(0, input.indexOf("\n"));
      void respond(socket, line);
    });
  });

  server.on("error", (error) => {
    console.error(toErrorMessage(error));
    process.exit(1);
  });

  server.listen(SOCKET_PATH, async () => {
    if (!isWindowsNamedPipe(SOCKET_PATH)) {
      await chmod(SOCKET_PATH, 0o600);
    }
    await writeFile(PID_PATH, String(process.pid), "utf8");
    process.stdout.write(`agent-database-cli daemon started: ${SOCKET_PATH}\n`);
    touchDaemonIdleTimer();
  });

  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
}

async function respond(socket: net.Socket, line: string): Promise<void> {
  try {
    touchDaemonIdleTimer();
    const request = JSON.parse(line) as DaemonRequest;
    const response = await handleRequest(request);
    touchDaemonIdleTimer();
    socket.end(JSON.stringify(response));
  } catch (error) {
    touchDaemonIdleTimer();
    socket.end(JSON.stringify({ ok: false, error: toErrorMessage(error) } satisfies DaemonResponse));
  }
}

function touchDaemonIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    void shutdown(0);
  }, DAEMON_IDLE_SECONDS * 1000);
  idleTimer.unref();
}

async function shutdown(code: number): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  await configManager.closeAll();
  if (!isWindowsNamedPipe(SOCKET_PATH)) {
    await rm(SOCKET_PATH, { force: true });
  }
  await rm(PID_PATH, { force: true });
  process.exit(code);
}

export async function readDaemonPid(): Promise<number | undefined> {
  try {
    return Number((await readFile(PID_PATH, "utf8")).trim());
  } catch {
    return undefined;
  }
}

void start();
