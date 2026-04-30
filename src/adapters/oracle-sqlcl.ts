import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { BaseSqlAdapter } from "./base-sql.js";
import type { QueryResult } from "../types.js";
import { maskSecret } from "../utils/masking.js";

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
    const output = await this.runSqlcl(command);
    return {
      rows: [{ output }],
      fields: ["output"],
      rowCount: output ? 1 : 0
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

  private runSqlcl(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.sqlclPath, ["-S", "/nolog"], {
        env: this.buildEnv(),
        stdio: ["pipe", "pipe", "pipe"]
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
        if (code === 0) {
          resolve(stripAnsi(stdout).trim());
          return;
        }
        reject(new Error(maskSecret(`SQLcl 执行失败(code=${code}): ${stderr || stdout}`.trim())));
      });

      child.stdin.end(this.buildScript(command));
    });
  }

  private buildScript(command: string): string {
    const sql = command.trim().replace(/;+\s*$/, "");
    return [
      "set heading on",
      "set feedback off",
      "set pagesize 50000",
      "set linesize 32767",
      "whenever sqlerror exit sql.sqlcode",
      `connect ${this.buildConnectString()}`,
      `${sql};`,
      "exit"
    ].join("\n");
  }

  private buildConnectString(): string {
    const parsed = new URL(this.url);
    const user = quoteConnectPart(decodeURIComponent(parsed.username));
    const password = quoteConnectPart(decodeURIComponent(parsed.password));
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
}

function quoteConnectPart(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
