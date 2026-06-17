#!/usr/bin/env node
// Download the platform-native binary from this version's GitHub Release into
// bin/native/. The launcher (agent-database-cli.js) and the MCP server resolve
// the binary from there. Binaries are NOT shipped inside the npm package — only
// this tiny launcher is — so each install pulls just the one binary for its OS.
//
// Requires network access at install time. If you install with --ignore-scripts
// (so this never runs) or the download fails, the binary will be missing; build
// from source with `cargo build --release` or drop the binary into bin/native/.
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// platform-arch -> Rust target triple (matches the names release.yml uploads).
const targetByPlatform = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc"
};

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const exeName = isWindows ? "agent-database-cli.exe" : "agent-database-cli";
const destDir = join(packageRoot, "bin", "native");
const destPath = join(destDir, exeName);

function log(message) {
  console.log(`[agent-database-cli postinstall] ${message}`);
}

function devBuildExists() {
  return (
    existsSync(join(packageRoot, "target", "release", exeName)) ||
    existsSync(join(packageRoot, "target", "debug", exeName))
  );
}

function repoBaseUrl(version) {
  const pkg = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8")
  );
  const url = (pkg.repository?.url ?? "")
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
  if (!/^https?:\/\/github\.com\//.test(url)) {
    throw new Error(`cannot derive GitHub repo from repository.url: "${url}"`);
  }
  return `${url}/releases/download/v${version}/`;
}

async function download(url, outPath) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(outPath, buf);
  if (!isWindows) chmodSync(outPath, 0o755);
  return buf.length;
}

async function main() {
  if (process.env.AGENT_DATABASE_CLI_SKIP_DOWNLOAD) {
    log("AGENT_DATABASE_CLI_SKIP_DOWNLOAD set; skipping binary download.");
    return;
  }
  if (existsSync(destPath)) {
    log("native binary already present; nothing to download.");
    return;
  }
  if (devBuildExists()) {
    log("local cargo build found; using it, skipping download.");
    return;
  }

  const key = `${process.platform}-${process.arch}`;
  const target = targetByPlatform[key];
  if (!target) {
    throw new Error(`unsupported platform: ${key}`);
  }

  const pkg = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8")
  );
  const asset = `agent-database-cli-${target}${isWindows ? ".exe" : ""}`;
  const url = repoBaseUrl(pkg.version) + asset;

  mkdirSync(destDir, { recursive: true });
  log(`downloading ${asset} ...`);
  const bytes = await download(url, destPath);
  log(`installed native binary (${(bytes / 1e6).toFixed(1)} MB) -> ${destPath}`);
}

main().catch((error) => {
  console.error(
    `[agent-database-cli postinstall] failed to install native binary: ${
      error?.message ?? error
    }`
  );
  console.error(
    "The CLI will not run until the binary is available. Re-run the install with " +
      "network access, or build from source with `cargo build --release`."
  );
  process.exit(1);
});
