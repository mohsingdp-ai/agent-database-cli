import type { DaemonAction, MetadataRequest, QueryResult } from "./types.js";
import { resolveConfigPath } from "./config.js";
import { sendDaemonRequest } from "./daemon/client.js";
import { startDaemon } from "./daemon/control.js";

export async function runTest(db: string): Promise<unknown> {
  return runViaDaemonOrLocal("test", db);
}

export async function runExecute(db: string, command: string): Promise<QueryResult> {
  return runViaDaemonOrLocal("execute", db, command) as Promise<QueryResult>;
}

export async function runMetadata(db: string, metadata: MetadataRequest): Promise<QueryResult> {
  return runViaDaemonOrLocal("metadata", db, undefined, metadata) as Promise<QueryResult>;
}

export async function runReset(db: string): Promise<unknown> {
  return runViaDaemonOrLocal("reset", db);
}

async function runViaDaemonOrLocal(
  action: DaemonAction,
  db: string,
  command?: string,
  metadata?: MetadataRequest
): Promise<unknown> {
  const configPath = resolveConfigPath();
  await startDaemon();
  const response = await sendDaemonRequest({ action, db, command, metadata, configPath });
  if (!response.ok) {
    throw new Error(response.error || "daemon 执行失败");
  }
  return response.data;
}
