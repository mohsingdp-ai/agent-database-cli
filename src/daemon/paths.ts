import { homedir } from "node:os";
import { join } from "node:path";

export const RUNTIME_DIR = join(homedir(), ".database-cli");
export const SOCKET_PATH = join(RUNTIME_DIR, "database-cli.sock");
export const PID_PATH = join(RUNTIME_DIR, "database-cli.pid");
