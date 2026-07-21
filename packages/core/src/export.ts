import type { RelayJob } from "./types.js";

/**
 * Flat, tabular export of the job store — the counterpart to {@link computeStats}
 * (which aggregates) and the dashboard (which is live). Where `stats` answers
 * "how is the relay doing overall?", `export` hands you one row per job so you
 * can pull the raw history into a spreadsheet, a BI tool, or `jq`/`awk` for
 * ad-hoc analysis the built-in views don't cover.
 *
 * Everything here is pure (jobs in, string out) so it's trivially testable and
 * never touches the filesystem — the CLI layer decides where the bytes go.
 */

/**
 * The columns emitted by {@link jobsToCsv}, in order. Chosen to be the fields a
 * human actually filters/sorts on in a spreadsheet; the full lossless shape
 * (including `lastOutputTail` and the un-flattened `command` array) is what the
 * JSON export preserves. `command` is space-joined here for readability, so a
 * CSV row is a lossy-but-legible view and JSON is the exact one.
 */
export const JOB_CSV_COLUMNS = [
  "id",
  "project",
  "tool",
  "status",
  "attempts",
  "resetAt",
  "createdAt",
  "updatedAt",
  "command",
  "cwd",
  "lastError",
] as const;

export type JobCsvColumn = (typeof JOB_CSV_COLUMNS)[number];

/**
 * Parse a comma-separated `--fields` list into an ordered, de-duplicated set of
 * export columns. Each name is trimmed and empty entries are dropped, so
 * `"status, id ,"` yields `["status", "id"]`. Names outside {@link JOB_CSV_COLUMNS}
 * are collected in `invalid` (first-seen order) rather than throwing, so the CLI
 * can report every bad name at once. Order and de-duplication follow the user's
 * input (first occurrence wins), so the exported column order is exactly what
 * was asked for.
 */
export function parseColumns(input: string): { columns: JobCsvColumn[]; invalid: string[] } {
  const columns: JobCsvColumn[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.split(",")) {
    const name = raw.trim();
    if (name === "" || seen.has(name)) {
      continue;
    }
    seen.add(name);
    if ((JOB_CSV_COLUMNS as readonly string[]).includes(name)) {
      columns.push(name as JobCsvColumn);
    } else {
      invalid.push(name);
    }
  }
  return { columns, invalid };
}

/**
 * Project a job down to just the selected columns, in the given order, keeping
 * each field's native type (so `command` stays an array, `attempts` a number,
 * `resetAt`/`lastError` their string-or-null). Used by the JSON/NDJSON exports
 * when `--fields` narrows the output — CSV/Markdown flatten via {@link jobCsvValue}
 * instead. Every column in {@link JOB_CSV_COLUMNS} is a direct key on
 * {@link RelayJob}, so the projection is a straight key pick.
 */
export function projectJob(job: RelayJob, columns: readonly JobCsvColumn[]): Partial<RelayJob> {
  const out: Partial<RelayJob> = {};
  for (const col of columns) {
    (out as Record<string, unknown>)[col] = job[col];
  }
  return out;
}

/**
 * RFC 4180 field escaping: a field is wrapped in double quotes when it contains
 * a comma, a double quote, or a newline (CR or LF), and any embedded double
 * quotes are doubled. Everything else is emitted verbatim. This keeps commas in
 * commit-message-like prompts and multi-line `lastError` values from corrupting
 * the column layout.
 */
export function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Render a single job field as the flat string that lands in its CSV cell. */
export function jobCsvValue(job: RelayJob, column: JobCsvColumn): string {
  switch (column) {
    case "attempts":
      return String(job.attempts);
    case "command":
      return job.command.join(" ");
    case "resetAt":
      return job.resetAt ?? "";
    case "lastError":
      return job.lastError ?? "";
    default:
      // The remaining columns are all plain string fields on RelayJob.
      return job[column];
  }
}

export interface CsvOptions {
  /** Columns to emit, in order. Defaults to {@link JOB_CSV_COLUMNS}. */
  columns?: readonly JobCsvColumn[];
  /** Emit a header row of column names. Defaults to true. */
  header?: boolean;
}

/**
 * Serialize jobs to CSV (RFC 4180, LF line endings, no trailing newline). The
 * caller is responsible for choosing the job set/order — pass an already
 * filtered/sorted array. An empty job list still yields the header row (unless
 * `header: false`), so downstream tools see the schema rather than an empty file.
 */
export function jobsToCsv(jobs: RelayJob[], options: CsvOptions = {}): string {
  const columns = options.columns ?? JOB_CSV_COLUMNS;
  const rows: string[] = [];
  if (options.header !== false) {
    rows.push(columns.map(escapeCsvField).join(","));
  }
  for (const job of jobs) {
    rows.push(columns.map((col) => escapeCsvField(jobCsvValue(job, col))).join(","));
  }
  return rows.join("\n");
}

/**
 * Serialize jobs to pretty-printed JSON (2-space indent). Without a `columns`
 * subset this is lossless — the full {@link RelayJob} shape, including the
 * `command` array and `lastOutputTail`, round-trips exactly. When `columns` is
 * given (via `--fields`), each job is projected to just those keys, in order,
 * with their native types preserved.
 */
export function jobsToJson(jobs: RelayJob[], options: Pick<CsvOptions, "columns"> = {}): string {
  const cols = options.columns && options.columns.length > 0 ? options.columns : null;
  const payload = cols ? jobs.map((job) => projectJob(job, cols)) : jobs;
  return JSON.stringify(payload, null, 2);
}

/**
 * Escape a value for a single GitHub-flavored Markdown table cell. Pipes are the
 * only column-breaking character, so they're backslash-escaped; newlines (which
 * would end the table row) collapse to `<br>` so multi-line prompts and errors
 * stay inside their cell. An empty value becomes an em dash so the table reads
 * as "no value" rather than a blank that can look like a rendering glitch.
 */
export function escapeMarkdownCell(value: string): string {
  if (value === "") {
    return "—";
  }
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r\n|\r|\n/g, "<br>");
}

/**
 * Render jobs as a GitHub-flavored Markdown table — the human-readable
 * counterpart to CSV/JSON, meant for pasting into an issue, a PR body, or a
 * chat message where a rendered table is worth more than raw rows. Columns and
 * cell values are shared with the CSV export ({@link JOB_CSV_COLUMNS} /
 * {@link jobCsvValue}) so the two stay in lockstep. An empty job list still
 * emits the header and separator rows, so the table's schema is visible.
 */
export function jobsToMarkdown(jobs: RelayJob[], options: Pick<CsvOptions, "columns"> = {}): string {
  const columns = options.columns ?? JOB_CSV_COLUMNS;
  const rows: string[] = [];
  rows.push(`| ${columns.join(" | ")} |`);
  rows.push(`| ${columns.map(() => "---").join(" | ")} |`);
  for (const job of jobs) {
    rows.push(`| ${columns.map((col) => escapeMarkdownCell(jobCsvValue(job, col))).join(" | ")} |`);
  }
  return rows.join("\n");
}

/**
 * Serialize jobs to NDJSON (newline-delimited JSON): one compact JSON object
 * per line, LF-separated, no trailing newline (matching {@link jobsToCsv}/
 * {@link jobsToJson}; the CLI file writer adds the final LF). Like the JSON
 * form it is lossless — each line round-trips a full {@link RelayJob} — but,
 * like CSV, it streams: tools such as `jq -c`, `while read line`, and
 * log/BigQuery pipelines consume it a record at a time without parsing the
 * whole file. An empty job list yields an empty string. Like {@link jobsToJson},
 * a `columns` subset (via `--fields`) projects each record to just those keys.
 */
export function jobsToNdjson(jobs: RelayJob[], options: Pick<CsvOptions, "columns"> = {}): string {
  const cols = options.columns && options.columns.length > 0 ? options.columns : null;
  return jobs.map((job) => JSON.stringify(cols ? projectJob(job, cols) : job)).join("\n");
}

/** Supported export formats. */
export const EXPORT_FORMATS = ["csv", "json", "md", "ndjson"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Dispatch to the right serializer for the given format. */
export function exportJobs(jobs: RelayJob[], format: ExportFormat, options: CsvOptions = {}): string {
  switch (format) {
    case "json":
      return jobsToJson(jobs, options);
    case "md":
      return jobsToMarkdown(jobs, options);
    case "ndjson":
      return jobsToNdjson(jobs, options);
    default:
      return jobsToCsv(jobs, options);
  }
}
