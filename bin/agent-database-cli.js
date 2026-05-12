#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageByPlatform = {
  "darwin-arm64": "@agent-database-cli/darwin-arm64",
  "darwin-x64": "@agent-database-cli/darwin-x64",
  "linux-x64": "@agent-database-cli/linux-x64",
  "linux-arm64": "@agent-database-cli/linux-arm64",
  "win32-x64": "@agent-database-cli/win32-x64"
};

const key = `${process.platform}-${process.arch}`;
const packageName = packageByPlatform[key];
if (!packageName) {
  console.error(`agent-database-cli 暂不支持当前平台: ${key}`);
  process.exit(1);
}

const currentDir = dirname(fileURLToPath(import.meta.url));
const executableName = process.platform === "win32" ? "agent-database-cli.exe" : "agent-database-cli";
const executablePath = join(currentDir, "..", "node_modules", packageName, "bin", executableName);

const repoFallback = join(currentDir, "..", "target", "release", executableName);
const devFallback = join(currentDir, "..", "target", "debug", executableName);
const finalExecutablePath = existsSync(executablePath)
  ? executablePath
  : existsSync(repoFallback)
    ? repoFallback
    : existsSync(devFallback)
      ? devFallback
      : undefined;

if (!finalExecutablePath) {
  console.error(`未找到平台二进制: ${packageName}`);
  console.error("请重新安装 agent-database-cli，确保 optionalDependencies 没有被禁用。");
  process.exit(1);
}

const result = spawnSync(finalExecutablePath, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 0);
