// Data portability for the relay queue: turn a `RelayJob[]` into CSV, NDJSON,
// or a JSON array so the store can be opened in a spreadsheet, piped into `jq`,
// or loaded by an external analysis script. Pure string producers here (no I/O,
// no clock) so the exact bytes are unit-testable; the CLI `export` command wires
// these to a file or stdout.

import type { RelayJob } from "./types.js";

/** Serialization formats `agentrelay export` supports. */
export type ExportFormat = "csv" | "ndjson" | "json";

/** All known export formats (stable order), for CLI validation/help. */
export const EXPORT_FORMATS: ExportFormat[] = ["csv", "ndjson", "json"];

/**
 * Columns emitted for CSV, in a stable, spreadsheet-friendly order. `command`
 * is a string[] and `lastOutputTail` can be large/multi-line, so they are
 * intentionally excluded from the flat tabular view — use `json`/`ndjson` when
 * you need the full fidelity of every field.
 */
export const CSV_COLUMNS = [
  "id",
  "project",
  "tool",
  "status",
  "resetAt",
  "createdAt",
  "updatedAt",
  "attempts",
  "lastError",
  "cwd",
  "command",
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

/**
 * The scalar value for one CSV cell, before escaping. Nullable fields become an
 * empty string; `command` (string[]) is rendered as a JSON array so it stays
 * unambiguous and re-parseable inside a single cell; `attempts` is stringified.
 */
function cellValue(job: RelayJob, column: CsvColumn): string {
  switch (column) {
    case "attempts":
      return String(job.attempts);
    case "command":
      return JSON.stringify(job.command);
    case "resetAt":
      return job.resetAt ?? "";
    case "lastError":
      return job.lastError ?? "";
    default:
      return job[column];
  }
}

/**
 * Escape one field per RFC 4180: wrap in double quotes and double any embedded
 * quote when the value contains a quote, comma, CR, or LF; otherwise emit it
 * verbatim. Newlines inside a quoted field are valid CSV and survive round-trip.
 */
export function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Join one job's cells into a CSV record (no trailing EOL). */
function csvRow(cells: string[]): string {
  return cells.map(escapeCsvField).join(",");
}

/**
 * Render jobs as CSV with a header row. Rows use CRLF line endings (RFC 4180),
 * which Excel and Google Sheets both import cleanly; the trailing newline is
 * included so appending/concatenating stays clean. An empty job list still
 * yields the header row so downstream schemas don't break on "no jobs yet".
 */
export function toCsv(jobs: RelayJob[], eol = "\r\n"): string {
  const header = csvRow([...CSV_COLUMNS]);
  const rows = jobs.map((job) => csvRow(CSV_COLUMNS.map((col) => cellValue(job, col))));
  return [header, ...rows].join(eol) + eol;
}

/**
 * Render jobs as newline-delimited JSON: one full job object per line. Ideal for
 * streaming into `jq -c` or line-oriented tooling. An empty list yields "" (no
 * lines). A trailing newline is included when there is at least one job.
 */
export function toNdjson(jobs: RelayJob[]): string {
  if (jobs.length === 0) return "";
  return jobs.map((job) => JSON.stringify(job)).join("\n") + "\n";
}

/** Render jobs as a pretty-printed JSON array (2-space indent), no trailing EOL. */
export function toJsonArray(jobs: RelayJob[]): string {
  return JSON.stringify(jobs, null, 2);
}

/**
 * Serialize a job list into the requested export format. Single entry point so
 * the CLI stays format-agnostic. Throws on an unknown format (callers validate
 * against {@link EXPORT_FORMATS} first for a friendly error).
 */
export function serializeJobs(jobs: RelayJob[], format: ExportFormat): string {
  switch (format) {
    case "csv":
      return toCsv(jobs);
    case "ndjson":
      return toNdjson(jobs);
    case "json":
      return toJsonArray(jobs);
    default: {
      // Exhaustiveness guard: a new ExportFormat must add a case above.
      const never: never = format;
      throw new Error(`Unknown export format: ${String(never)}`);
    }
  }
}
