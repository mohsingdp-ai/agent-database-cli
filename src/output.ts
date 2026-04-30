import type { OutputFormat } from "./types.js";

export function writeOutput(data: unknown, format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatTable(data)}\n`);
}

function formatTable(data: unknown): string {
  const rows = Array.isArray(data)
    ? data
    : isObject(data) && Array.isArray(data.rows)
      ? data.rows
      : [data];
  if (rows.length === 0) {
    return "";
  }
  const objects: Array<Record<string, unknown>> = rows.map((row) => (isObject(row) ? row : { value: row }));
  const columns = [...new Set(objects.flatMap((row) => Object.keys(row)))];
  const widths = columns.map((column) =>
    Math.max(column.length, ...objects.map((row) => stringifyCell(row[column]).length))
  );
  const header = columns.map((column, index) => column.padEnd(widths[index])).join("  ");
  const divider = widths.map((width) => "-".repeat(width)).join("  ");
  const body = objects
    .map((row) => columns.map((column, index) => stringifyCell(row[column]).padEnd(widths[index])).join("  "))
    .join("\n");
  return [header, divider, body].join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
