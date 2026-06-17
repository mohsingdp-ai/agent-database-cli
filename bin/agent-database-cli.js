#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageByPlatform = {
  "darwin-arm64": "@mejazbese21/db-cli-darwin-arm64",
  "darwin-x64": "@mejazbese21/db-cli-darwin-x64",
  "linux-x64": "@mejazbese21/db-cli-linux-x64",
  "linux-arm64": "@mejazbese21/db-cli-linux-arm64",
  "win32-x64": "@mejazbese21/db-cli-win32-x64"
};

const key = `${process.platform}-${process.arch}`;
const packageName = packageByPlatform[key];
if (!packageName) {
  console.error(`agent-database-cli does not currently support this platform: ${key}`);
  process.exit(1);
}

const currentDir = dirname(fileURLToPath(import.meta.url));
const executableName = process.platform === "win32" ? "agent-database-cli.exe" : "agent-database-cli";
const packageRoot = join(currentDir, "..");
// The main package is scoped (@mejazbese21/agent-database-cli), so it installs one
// level deeper than an unscoped package: node_modules/@mejazbese21/agent-database-cli.
// installRoot must therefore be node_modules itself (two levels up) so that joining
// the already-scoped platform package name lands at node_modules/@mejazbese21/db-cli-*.
const installRoot = join(packageRoot, "..", "..");

const candidateExecutablePaths = [
  // On a normal npm install, the platform sub-package sits alongside the main package under node_modules/@mejazbese21/*.
  join(installRoot, packageName, "bin", executableName),
  // Handle the rare package managers that nest optionalDependencies inside the main package's node_modules.
  join(packageRoot, "node_modules", packageName, "bin", executableName)
];

const repoFallback = join(currentDir, "..", "target", "release", executableName);
const devFallback = join(currentDir, "..", "target", "debug", executableName);
const packagedExecutablePath = candidateExecutablePaths.find((candidate) => existsSync(candidate));
const finalExecutablePath = packagedExecutablePath
  ?? (existsSync(repoFallback)
    ? repoFallback
    : existsSync(devFallback)
      ? devFallback
      : undefined);

if (!finalExecutablePath) {
  console.error(`Platform binary not found: ${packageName}`);
  console.error("Please reinstall agent-database-cli and make sure optionalDependencies are not disabled.");
  process.exit(1);
}

const env = { ...process.env, AGENT_DATABASE_CLI_PACKAGE_DIR: packageRoot };
const result = spawnSync(finalExecutablePath, process.argv.slice(2), { stdio: "inherit", env });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 0);
