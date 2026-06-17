#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// The native binary is downloaded into bin/native/ by postinstall.js (fetched
// from this version's GitHub Release). Dev fallbacks: a locally built binary.
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const exe =
  process.platform === "win32" ? "agent-database-cli.exe" : "agent-database-cli";

const candidates = [
  join(packageRoot, "bin", "native", exe),
  join(packageRoot, "target", "release", exe),
  join(packageRoot, "target", "debug", exe)
];

const bin = candidates.find((candidate) => existsSync(candidate));
if (!bin) {
  console.error("agent-database-cli: native binary not found.");
  console.error(
    "Reinstall the package (the binary is downloaded from GitHub Releases on install),"
  );
  console.error("or build from source with `cargo build --release`.");
  process.exit(1);
}

const env = { ...process.env, AGENT_DATABASE_CLI_PACKAGE_DIR: packageRoot };
const result = spawnSync(bin, process.argv.slice(2), { stdio: "inherit", env });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 0);
