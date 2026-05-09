#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { loadConfig, listSupportedDatabases, resolveConfigPath } from "./config.js";
import { daemonStatus, startDaemon, stopDaemon } from "./daemon/control.js";
import { writeOutput } from "./output.js";
import { runExecute, runMetadata, runReset, runTest } from "./runtime.js";
import type { MetadataRequest, OutputFormat } from "./types.js";
import { toErrorMessage } from "./utils/masking.js";

const program = new Command();
const packageVersion = readPackageVersion();

program
  .name("agent-database-cli")
  .description("统一数据库命令行工具")
  .version(packageVersion)
  .option("--format <format>", "输出格式: json 或 table", "json");

program.command("list").description("展示支持的数据库类型").action(async () => {
  await main(async () => {
    const configPath = resolveConfigPath();
    let configured: string[] = [];
    try {
      const config = await loadConfig(configPath);
      configured = Object.keys(config.databases);
    } catch {
      configured = [];
    }
    writeOutput(
      {
        supported: listSupportedDatabases(),
        configured,
        configPath
      },
      getFormat()
    );
  });
});

program
  .command("test")
  .description("测试数据库连接")
  .requiredOption("--db <name>", "数据库配置名")
  .action(async (options: { db: string }) => {
    await main(async () => {
      writeOutput(await runTest(options.db), getFormat());
    });
  });

program
  .command("exec")
  .description("统一执行 SQL、Redis 命令或 MongoDB JSON 命令")
  .requiredOption("--db <name>", "数据库配置名")
  .requiredOption("--command <command>", "待执行命令")
  .action(async (options: { db: string; command: string }) => {
    await main(async () => {
      writeOutput(await runExecute(options.db, options.command), getFormat());
    });
  });

program
  .command("meta")
  .description("查询数据库元信息")
  .requiredOption("--db <name>", "数据库配置名")
  .requiredOption("--type <type>", "元信息类型: tables, columns, collections, keys")
  .option("--table <table>", "columns 查询的表名")
  .option("--pattern <pattern>", "keys 查询的匹配模式")
  .action(async (options: { db: string; type: MetadataRequest["type"]; table?: string; pattern?: string }) => {
    await main(async () => {
      writeOutput(
        await runMetadata(options.db, { type: options.type, table: options.table, pattern: options.pattern }),
        getFormat()
      );
    });
  });

program
  .command("reset")
  .description("重置指定数据库连接")
  .requiredOption("--db <name>", "数据库配置名")
  .action(async (options: { db: string }) => {
    await main(async () => {
      writeOutput(await runReset(options.db), getFormat());
    });
  });

const daemon = program.command("daemon").description("管理本地连接守护进程");

daemon.command("start").description("启动 daemon").action(async () => {
  await main(async () => {
    writeOutput(await startDaemon(), getFormat());
  });
});

daemon.command("stop").description("停止 daemon").action(async () => {
  await main(async () => {
    writeOutput(await stopDaemon(), getFormat());
  });
});

daemon.command("status").description("查看 daemon 状态").action(async () => {
  await main(async () => {
    writeOutput(await daemonStatus(), getFormat());
  });
});

function getFormat(): OutputFormat {
  const format = program.opts<{ format: string }>().format;
  if (format !== "json" && format !== "table") {
    throw new Error(`不支持的输出格式: ${format}`);
  }
  return format;
}

async function main(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    process.stderr.write(`${toErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

function readPackageVersion(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const packageJsonPath = resolve(dirname(currentFile), "../package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json 缺少有效的 version");
  }
  return packageJson.version;
}

await program.parseAsync(process.argv);
