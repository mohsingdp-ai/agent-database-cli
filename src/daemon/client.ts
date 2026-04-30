import net from "node:net";
import type { DaemonRequest, DaemonResponse } from "../types.js";
import { SOCKET_PATH } from "./paths.js";

export function sendDaemonRequest(request: DaemonRequest): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    let buffer = "";

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolve(JSON.parse(buffer) as DaemonResponse);
      } catch {
        reject(new Error("daemon 返回了无效响应"));
      }
    });
  });
}

export async function isDaemonRunning(): Promise<boolean> {
  try {
    const response = await sendDaemonRequest({ action: "status" });
    return response.ok;
  } catch {
    return false;
  }
}
