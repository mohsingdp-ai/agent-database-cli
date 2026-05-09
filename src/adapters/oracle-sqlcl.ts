import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { BaseSqlAdapter } from "./base-sql.js";
import type { QueryResult } from "../types.js";
import { maskSecret } from "../utils/masking.js";

const SQLCL_META_COMMANDS = new Set([
  "@",
  "@@",
  "accept",
  "append",
  "break",
  "clear",
  "column",
  "connect",
  "copy",
  "define",
  "disconnect",
  "edit",
  "execute",
  "exit",
  "get",
  "host",
  "input",
  "list",
  "password",
  "pause",
  "print",
  "prompt",
  "quit",
  "remark",
  "run",
  "save",
  "set",
  "show",
  "spool",
  "start",
  "undefine",
  "variable",
  "whenever"
]);

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
    const markers = createQueryResultMarkers();
    return this.withTempScript(command, markers, (scriptPath) => new Promise((resolve, reject) => {
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
          resolve(parseSqlclOutput(stdoutOutput, stderrOutput, markers));
          return;
        }
        reject(new Error(maskSecret(`SQLcl 执行失败(code=${code}): ${stderr || stdout}`.trim())));
      });
    }));
  }

  private buildScript(command: string, markers: QueryResultMarkers): string {
    const sql = normalizeSqlclSql(command);
    return [
      "set heading on",
      "set feedback off",
      "set pagesize 50000",
      "set linesize 32767",
      "set sqlformat json",
      "whenever sqlerror exit sql.sqlcode",
      `connect ${this.buildConnectString()}`,
      `prompt ${markers.begin}`,
      `${sql};`,
      `prompt ${markers.end}`,
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

  private async withTempScript<T>(
    command: string,
    markers: QueryResultMarkers,
    run: (scriptPath: string) => Promise<T>
  ): Promise<T> {
    const directoryPath = await mkdtemp(join(tmpdir(), "agent-database-cli-sqlcl-"));
    const scriptPath = join(directoryPath, "command.sql");
    try {
      await writeFile(scriptPath, this.buildScript(command, markers), { encoding: "utf8", mode: 0o600 });
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

interface QueryResultMarkers {
  begin: string;
  end: string;
}

function createQueryResultMarkers(): QueryResultMarkers {
  const token = randomUUID().replace(/-/g, "");
  return {
    begin: `__DATABASE_CLI_SQLCL_RESULT_BEGIN_${token}__`,
    end: `__DATABASE_CLI_SQLCL_RESULT_END_${token}__`
  };
}

function parseSqlclOutput(
  stdoutOutput: string,
  stderrOutput: string,
  markers: QueryResultMarkers
): { output: string; queryResult?: QueryResult } {
  const preferredOutput = stdoutOutput || stderrOutput;
  const markerResult = extractMarkedSection(stdoutOutput, markers) ?? extractMarkedSection(stderrOutput, markers);
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

function extractMarkedSection(output: string, markers: QueryResultMarkers): { section: string } | undefined {
  const beginIndex = output.indexOf(markers.begin);
  const endIndex = output.indexOf(markers.end);
  if (beginIndex === -1 || endIndex === -1 || endIndex <= beginIndex) {
    return undefined;
  }
  const section = output
    .slice(beginIndex + markers.begin.length, endIndex)
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

function normalizeSqlclSql(command: string): string {
  const sql = command.trim().replace(/;+\s*$/, "");
  assertSingleSqlStatement(sql);
  assertNoSqlclMetaCommand(sql);
  return sql;
}

function assertSingleSqlStatement(command: string): void {
  const sanitized = stripSqlLiteralsAndComments(command);
  if (sanitized.includes(";")) {
    throw new Error("SQLcl 模式仅允许执行单条 SQL 语句");
  }
}

function assertNoSqlclMetaCommand(command: string): void {
  const sanitized = stripSqlLiteralsAndComments(command);
  for (const line of sanitized.split(/\r?\n/)) {
    const head = line.trim().split(/\s+/)[0]?.toLowerCase();
    if (head && (SQLCL_META_COMMANDS.has(head) || head.startsWith("@"))) {
      throw new Error(`SQLcl 模式拒绝执行 SQLcl 元命令: ${head}`);
    }
  }
}

function stripSqlLiteralsAndComments(command: string): string {
  let result = "";
  let index = 0;

  while (index < command.length) {
    const char = command[index];
    const next = command[index + 1];

    if (char === "-" && next === "-") {
      const endIndex = findLineEnd(command, index + 2);
      result += " ".repeat(endIndex - index);
      index = endIndex;
      continue;
    }

    if (char === "/" && next === "*") {
      const commentEnd = command.indexOf("*/", index + 2);
      const endIndex = commentEnd === -1 ? command.length : commentEnd + 2;
      result += " ".repeat(endIndex - index);
      index = endIndex;
      continue;
    }

    if (char === "'") {
      const endIndex = findQuotedTokenEnd(command, index);
      result += " ".repeat(endIndex - index);
      index = endIndex;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

function findLineEnd(command: string, start: number): number {
  const lineEnd = command.indexOf("\n", start);
  return lineEnd === -1 ? command.length : lineEnd;
}

function findQuotedTokenEnd(command: string, start: number): number {
  let index = start + 1;
  while (index < command.length) {
    if (command[index] === "'") {
      if (command[index + 1] === "'") {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return command.length;
}
