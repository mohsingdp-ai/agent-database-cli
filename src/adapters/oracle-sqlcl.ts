import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { BaseSqlAdapter } from "./base-sql.js";
import type { QueryResult } from "../types.js";
import { maskSecret } from "../utils/masking.js";

const QUERY_RESULT_BEGIN_MARKER = "__DATABASE_CLI_SQLCL_RESULT_BEGIN__";
const QUERY_RESULT_END_MARKER = "__DATABASE_CLI_SQLCL_RESULT_END__";

export class OracleSqlclAdapter extends BaseSqlAdapter {
  constructor(
    private readonly url: string,
    private readonly sqlclPath = "sql",
    private readonly javaHome?: string
  ) {
    super();
  }

  async connect(): Promise<void> {
    // SQLcl 是短进程 CLI，不维护驱动级长连接；daemon 会复用配置和执行入口。
  }

  async disconnect(): Promise<void> {
    // SQLcl 每次命令执行后进程退出，无需显式断开。
  }

  async execute(command: string): Promise<QueryResult> {
    const result = await this.runSqlcl(command);
    if (result.queryResult) {
      return result.queryResult;
    }
    return {
      rows: [{ output: result.output }],
      fields: ["output"],
      rowCount: result.output ? 1 : 0
    };
  }

  protected testQuery(): string {
    return "select 1 from dual";
  }

  protected async listTables(): Promise<QueryResult> {
    return this.execute("select table_name from user_tables order by table_name");
  }

  protected async listColumns(table: string): Promise<QueryResult> {
    const escaped = table.replace(/'/g, "''").toUpperCase();
    return this.execute(
      `select table_name, column_name, data_type from user_tab_columns where table_name = '${escaped}' order by column_id`
    );
  }

  private runSqlcl(command: string): Promise<{ output: string; queryResult?: QueryResult }> {
    return this.withTempScript(command, (scriptPath) => new Promise((resolve, reject) => {
      const child = spawn(this.sqlclPath, ["-S", "/nolog", `@${scriptPath}`], {
        env: this.buildEnv(),
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        reject(new Error(`SQLcl 启动失败: ${error.message}`));
      });
      child.on("close", (code) => {
        const stdoutOutput = stripAnsi(stdout).trim();
        const stderrOutput = stripAnsi(stderr).trim();
        const combinedOutput = [stdoutOutput, stderrOutput].filter(Boolean).join("\n");
        if (containsSqlclError(combinedOutput)) {
          reject(new Error(maskSecret(`SQLcl 执行失败: ${combinedOutput}`.trim())));
          return;
        }
        if (code === 0) {
          resolve(parseSqlclOutput(stdoutOutput, stderrOutput));
          return;
        }
        reject(new Error(maskSecret(`SQLcl 执行失败(code=${code}): ${stderr || stdout}`.trim())));
      });
    }));
  }

  private buildScript(command: string): string {
    const sql = command.trim().replace(/;+\s*$/, "");
    return [
      "set heading on",
      "set feedback off",
      "set pagesize 50000",
      "set linesize 32767",
      "set sqlformat json",
      "whenever sqlerror exit sql.sqlcode",
      `connect ${this.buildConnectString()}`,
      `prompt ${QUERY_RESULT_BEGIN_MARKER}`,
      `${sql};`,
      `prompt ${QUERY_RESULT_END_MARKER}`,
      "exit"
    ].join("\n");
  }

  private buildConnectString(): string {
    const parsed = new URL(this.url);
    const user = decodeURIComponent(parsed.username);
    const password = quotePassword(decodeURIComponent(parsed.password));
    const service = parsed.pathname.replace(/^\//, "");
    return `${user}/${password}@//${parsed.hostname}:${parsed.port || "1521"}/${service}`;
  }

  private buildEnv(): NodeJS.ProcessEnv {
    if (!this.javaHome) {
      return {
        ...process.env,
        NO_COLOR: "1",
        TERM: "dumb"
      };
    }
    const binPath = `${this.javaHome}/bin`;
    return {
      ...process.env,
      JAVA_HOME: this.javaHome,
      PATH: `${binPath}:${dirname(this.sqlclPath)}:${process.env.PATH ?? ""}`,
      NO_COLOR: "1",
      TERM: "dumb"
    };
  }

  private async withTempScript<T>(command: string, run: (scriptPath: string) => Promise<T>): Promise<T> {
    const directoryPath = await mkdtemp(join(tmpdir(), "database-cli-sqlcl-"));
    const scriptPath = join(directoryPath, "command.sql");
    try {
      await writeFile(scriptPath, this.buildScript(command), "utf8");
      return await run(scriptPath);
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  }
}

function quotePassword(value: string): string {
  if (!/[^\w$#]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function parseSqlclOutput(stdoutOutput: string, stderrOutput: string): { output: string; queryResult?: QueryResult } {
  const preferredOutput = stdoutOutput || stderrOutput;
  const markerResult = extractMarkedSection(stdoutOutput) ?? extractMarkedSection(stderrOutput);
  if (!markerResult) {
    return { output: preferredOutput };
  }
  const parsedJson = tryParseJson(markerResult.section);
  if (!parsedJson) {
    return { output: markerResult.section };
  }
  const rows = normalizeRows(parsedJson);
  if (!rows) {
    return { output: markerResult.section };
  }
  return {
    output: markerResult.section,
    queryResult: {
      rows,
      fields: collectFields(rows),
      rowCount: rows.length
    }
  };
}

function extractMarkedSection(output: string): { section: string } | undefined {
  const beginIndex = output.indexOf(QUERY_RESULT_BEGIN_MARKER);
  const endIndex = output.indexOf(QUERY_RESULT_END_MARKER);
  if (beginIndex === -1 || endIndex === -1 || endIndex <= beginIndex) {
    return undefined;
  }
  const section = output
    .slice(beginIndex + QUERY_RESULT_BEGIN_MARKER.length, endIndex)
    .trim();
  return { section };
}

function tryParseJson(value: string): unknown | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function normalizeRows(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (isRecord(value) && Array.isArray(value.items)) {
    return value.items;
  }
  if (
    isRecord(value) &&
    Array.isArray(value.results) &&
    value.results.length > 0 &&
    isRecord(value.results[0]) &&
    Array.isArray(value.results[0].items)
  ) {
    return value.results[0].items;
  }
  return undefined;
}

function collectFields(rows: unknown[]): string[] {
  const fields = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }
    for (const key of Object.keys(row)) {
      fields.add(key);
    }
  }
  return [...fields];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function containsSqlclError(output: string): boolean {
  if (!output) {
    return false;
  }
  return /(^|\n)\s*(SP2-|ORA-)/i.test(output);
}
