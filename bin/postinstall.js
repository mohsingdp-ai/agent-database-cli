#!/usr/bin/env node
// Speed up CLI startup by removing Node.js from the launch hot path.
//
// The default `bin` entry (agent-database-cli.js) boots Node just to spawn the
// native Rust binary — that Node startup costs ~150 ms on every invocation.
// This postinstall rewrites the npm-generated launcher shims so they invoke the
// native binary directly (no Node).
//
// It is intentionally defensive: if anything cannot be resolved it exits 0 and
// leaves the working Node shim in place. So `--ignore-scripts` installs (where
// this never runs) and unusual layouts keep working — just at the slower speed.
import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageByPlatform = {
  "darwin-arm64": "@agent-database-cli/darwin-arm64",
  "darwin-x64": "@agent-database-cli/darwin-x64",
  "linux-x64": "@agent-database-cli/linux-x64",
  "linux-arm64": "@agent-database-cli/linux-arm64",
  "win32-x64": "@agent-database-cli/win32-x64"
};

// The native binary inside the platform sub-package is always named this.
const NATIVE_NAME = "agent-database-cli";
// Launcher command names to optimize (the `bin` entries that point at the Node
// launcher). The `-mcp` bins are intentionally excluded: the MCP server is a
// Node program and must keep its Node shim.
const SHIM_NAMES = ["agent-database-cli", "db-cli"];

function log(message) {
  console.log(`[agent-database-cli postinstall] ${message}`);
}

function resolveNativeBinary() {
  const key = `${process.platform}-${process.arch}`;
  const packageName = packageByPlatform[key];
  if (!packageName) return null;

  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const installRoot = join(packageRoot, "..");
  const executableName =
    process.platform === "win32" ? `${NATIVE_NAME}.exe` : NATIVE_NAME;

  const candidates = [
    join(installRoot, packageName, "bin", executableName),
    join(packageRoot, "node_modules", packageName, "bin", executableName)
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

// Candidate directories where npm wrote the launcher shims for THIS install.
// Derived strictly from this package's own location so a local install never
// reaches out and rewrites another install's shims (e.g. a global one).
// We deliberately do NOT use npm_config_prefix: it points at the global prefix
// even during a local install, which would clobber the global shim.
function shimDirectories(packageRoot) {
  const dirs = [
    join(packageRoot, "..", ".bin"), // local: <tree>/node_modules/.bin
    join(packageRoot, "..", ".."), // global Windows: <prefix> (pkg at <prefix>/node_modules/<pkg>)
    join(packageRoot, "..", "..", "..", "bin") // global POSIX: <prefix>/bin (pkg at <prefix>/lib/node_modules/<pkg>)
  ];
  return [...new Set(dirs)].filter((dir) => existsSync(dir));
}

function shimContents(exe) {
  return {
    // POSIX / git-bash shell shim
    "": `#!/bin/sh\nexec "${exe}" "$@"\n`,
    // Windows cmd shim
    ".cmd": `@ECHO off\r\n"${exe}" %*\r\n`,
    // PowerShell shim
    ".ps1": `#!/usr/bin/env pwsh\n& "${exe}" $args\nexit $LASTEXITCODE\n`
  };
}

function rewriteShimsIn(dir, exe) {
  let rewritten = 0;
  const templates = shimContents(exe);
  for (const name of SHIM_NAMES) {
    for (const [ext, body] of Object.entries(templates)) {
      const file = join(dir, `${name}${ext}`);
      if (!existsSync(file)) continue;
      try {
        // Safety guard: only rewrite a file that is actually our launcher shim
        // (npm's Node shim references our package launcher; our own rewrite
        // references the native exe). Both contain "agent-database-cli", so this
        // avoids touching anything unexpected.
        const current = readFileSync(file, "utf8");
        if (!current.includes(NATIVE_NAME)) continue;
        if (current === body) continue; // already optimized; nothing to do
        writeFileSync(file, body);
        if (ext === "") chmodSync(file, 0o755);
        rewritten += 1;
      } catch {
        // Leave the original shim in place on any failure.
      }
    }
  }
  return rewritten;
}

function main() {
  const exe = resolveNativeBinary();
  if (!exe) {
    log("native binary not found; keeping Node launcher (CLI still works).");
    return;
  }
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  let total = 0;
  for (const dir of shimDirectories(packageRoot)) {
    total += rewriteShimsIn(dir, exe);
  }
  if (total > 0) {
    log(`enabled Node-free fast launch (${total} shim(s) -> ${exe}).`);
  } else {
    log("no launcher shims found to optimize; keeping Node launcher.");
  }
}

try {
  main();
} catch (error) {
  // Never fail the install for a performance optimization.
  log(`skipped (${error?.message ?? error}); CLI still works via Node launcher.`);
}
