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
 * Serialize jobs to pretty-printed JSON (2-space indent). Unlike the CSV form
 * this is lossless — the full {@link RelayJob} shape, including the `command`
 * array and `lastOutputTail`, round-trips exactly.
 */
export function jobsToJson(jobs: RelayJob[]): string {
  return JSON.stringify(jobs, null, 2);
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
 * whole file. An empty job list yields an empty string.
 */
export function jobsToNdjson(jobs: RelayJob[]): string {
  return jobs.map((job) => JSON.stringify(job)).join("\n");
}

/**
 * Escape a value for HTML text/attribute context. The five characters that can
 * break out of an element body or a double-quoted attribute (`&`, `<`, `>`, `"`,
 * `'`) are replaced with their entities. `&` is handled first so already-escaped
 * output isn't double-escaped incorrectly. Used by {@link jobsToHtml} so a
 * prompt or error containing `<`/`&`/quotes renders as literal text rather than
 * being interpreted as markup.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface HtmlOptions extends Pick<CsvOptions, "columns"> {
  /** Document `<title>` and page heading. Defaults to "AgentRelay job export". */
  title?: string;
}

/**
 * Render jobs as a **self-contained, styled HTML document** — the offline,
 * browsable counterpart to the Next.js dashboard (which needs a running server)
 * and to the Markdown export (which needs a Markdown renderer to look like a
 * table). Everything (CSS included) is inlined into one `<!doctype html>` file
 * with no external assets, so `agentrelay export -f html -o report.html` yields
 * a single file you can double-click, email, or archive.
 *
 * The document is theme-aware (`prefers-color-scheme`), the table scrolls
 * horizontally on narrow viewports rather than overflowing the page, and each
 * job's status renders as a colored badge. Columns and cell values are shared
 * with the CSV/Markdown exports ({@link JOB_CSV_COLUMNS} / {@link jobCsvValue})
 * so the three stay in lockstep; every cell is {@link escapeHtml}-escaped. A
 * summary line (total + a breakdown by status, both derived purely from the job
 * list) sits above the table. An empty job list still produces a valid document
 * with a "No jobs to show" note. Output is deterministic (no embedded clock), so
 * it round-trips cleanly in tests.
 */
export function jobsToHtml(jobs: RelayJob[], options: HtmlOptions = {}): string {
  const columns = options.columns ?? JOB_CSV_COLUMNS;
  const title = options.title ?? "AgentRelay job export";
  const escapedTitle = escapeHtml(title);

  // Status breakdown for the summary line — pure, order follows first appearance.
  const statusCounts = new Map<string, number>();
  for (const job of jobs) {
    statusCounts.set(job.status, (statusCounts.get(job.status) ?? 0) + 1);
  }
  const breakdown = [...statusCounts.entries()].map(([status, count]) => `${escapeHtml(status)}: ${count}`).join(" · ");
  const summary = jobs.length === 0 ? `${jobs.length} job(s)` : `${jobs.length} job(s) — ${breakdown}`;

  const headerCells = columns.map((col) => `<th>${escapeHtml(col)}</th>`).join("");

  const bodyRows =
    jobs.length === 0
      ? `<tr><td class="empty" colspan="${columns.length}">No jobs to show.</td></tr>`
      : jobs
          .map((job) => {
            const cells = columns
              .map((col) => {
                if (col === "status") {
                  const s = escapeHtml(job.status);
                  return `<td><span class="badge badge-${s}">${s}</span></td>`;
                }
                return `<td>${escapeHtml(jobCsvValue(job, col))}</td>`;
              })
              .join("");
            return `<tr>${cells}</tr>`;
          })
          .join("\n");

  // A single inlined stylesheet — light/dark via prefers-color-scheme, a table
  // that scrolls inside its own container so the page body never overflows.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapedTitle}</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1a1a1a; --muted: #6b7280;
  --border: #e5e7eb; --head-bg: #f9fafb; --row-alt: #fafafa;
  --queued: #6b7280; --waiting_for_reset: #b45309; --resuming: #1d4ed8;
  --completed: #15803d; --failed: #b91c1c; --cancelled: #4b5563;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --fg: #e5e7eb; --muted: #9ca3af;
    --border: #2a2f3a; --head-bg: #171a21; --row-alt: #14171d;
    --queued: #9ca3af; --waiting_for_reset: #f59e0b; --resuming: #60a5fa;
    --completed: #4ade80; --failed: #f87171; --cancelled: #9ca3af;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1.5rem; background: var(--bg); color: var(--fg);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
.summary { color: var(--muted); margin: 0 0 1.25rem; }
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td {
  text-align: left; padding: .5rem .75rem; border-bottom: 1px solid var(--border);
  white-space: nowrap; vertical-align: top;
}
th { background: var(--head-bg); font-weight: 600; position: sticky; top: 0; }
tbody tr:nth-child(even) { background: var(--row-alt); }
tbody tr:last-child td { border-bottom: none; }
td.empty { text-align: center; color: var(--muted); white-space: normal; }
.badge {
  display: inline-block; padding: .1rem .5rem; border-radius: 999px;
  font-size: .75rem; font-weight: 600; color: #fff; background: var(--queued);
}
.badge-queued { background: var(--queued); }
.badge-waiting_for_reset { background: var(--waiting_for_reset); }
.badge-resuming { background: var(--resuming); }
.badge-completed { background: var(--completed); }
.badge-failed { background: var(--failed); }
.badge-cancelled { background: var(--cancelled); }
</style>
</head>
<body>
<h1>${escapedTitle}</h1>
<p class="summary">${escapeHtml(summary)}</p>
<div class="table-wrap">
<table>
<thead><tr>${headerCells}</tr></thead>
<tbody>
${bodyRows}
</tbody>
</table>
</div>
</body>
</html>`;
}

/** Supported export formats. */
export const EXPORT_FORMATS = ["csv", "json", "md", "ndjson", "html"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Dispatch to the right serializer for the given format. */
export function exportJobs(jobs: RelayJob[], format: ExportFormat, options: CsvOptions = {}): string {
  switch (format) {
    case "json":
      return jobsToJson(jobs);
    case "md":
      return jobsToMarkdown(jobs, options);
    case "ndjson":
      return jobsToNdjson(jobs);
    case "html":
      return jobsToHtml(jobs, options);
    default:
      return jobsToCsv(jobs, options);
  }
}
