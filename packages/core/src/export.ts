// Export the job queue to portable formats (CSV / JSON) so relay history can
// be pulled into a spreadsheet or another tool for analysis — e.g. a small
// team lead reviewing who is blocked and for how long (SPEC §2 persona).
//
// Everything here is a pure function over an array of jobs: no store reads, no
// clock, no I/O. The CLI (`agentrelay export`) does the filtering (via the same
// `selectJobs` used by `status`) and the file/stdout writing.

import type { RelayJob } from "./types.js";

/** One column in the tabular (CSV) export: a stable header + a cell accessor. */
export interface ExportColumn {
  /** Header cell / JSON-ish key. Stable across releases so consumers can rely on it. */
  header: string;
  /** Extracts the raw (unescaped) string value for a job. */
  get: (job: RelayJob) => string;
}

/** Render a nullable value as an empty cell rather than the literal "null". */
function orEmpty(value: string | null | undefined): string {
  return value ?? "";
}

/**
 * The default export columns, in a deliberate order (identity → lifecycle →
 * timing → payload). `command` is joined with spaces for readability; it is a
 * display rendering, not something meant to be fed back into a shell. `attempts`
 * is stringified as-is. Newlines inside `lastError`/`lastOutputTail` are
 * preserved and handled by CSV quoting.
 */
export const EXPORT_COLUMNS: ExportColumn[] = [
  { header: "id", get: (j) => j.id },
  { header: "project", get: (j) => j.project },
  { header: "tool", get: (j) => j.tool },
  { header: "status", get: (j) => j.status },
  { header: "resetAt", get: (j) => orEmpty(j.resetAt) },
  { header: "createdAt", get: (j) => j.createdAt },
  { header: "updatedAt", get: (j) => j.updatedAt },
  { header: "attempts", get: (j) => String(j.attempts) },
  { header: "command", get: (j) => j.command.join(" ") },
  { header: "cwd", get: (j) => j.cwd },
  { header: "lastError", get: (j) => orEmpty(j.lastError) },
  { header: "lastOutputTail", get: (j) => orEmpty(j.lastOutputTail) },
];

/**
 * Escapes a single CSV field per RFC 4180: a field is wrapped in double quotes
 * when it contains a comma, a double quote, or a line break, and any embedded
 * double quotes are doubled. Other fields are emitted verbatim.
 */
export function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Renders jobs as a CSV document (header row + one row per job). Rows are
 * separated by CRLF as the spec recommends, which spreadsheet apps handle
 * uniformly; the input order is preserved (the caller sorts/filters first).
 */
export function jobsToCsv(jobs: RelayJob[], columns: ExportColumn[] = EXPORT_COLUMNS): string {
  const rows: string[] = [];
  rows.push(columns.map((c) => escapeCsvField(c.header)).join(","));
  for (const job of jobs) {
    rows.push(columns.map((c) => escapeCsvField(c.get(job))).join(","));
  }
  return rows.join("\r\n");
}

/**
 * Renders jobs as a pretty-printed JSON array — a straight dump of the job
 * records (unlike `status --json`, which wraps them in a `{storePath, …}`
 * envelope), so the output round-trips cleanly as data.
 */
export function jobsToJson(jobs: RelayJob[]): string {
  return JSON.stringify(jobs, null, 2);
}
