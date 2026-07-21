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
 * Escape a value for safe embedding in HTML text/attribute content. Only the
 * five characters that can break out of a text node or a double-quoted
 * attribute are replaced; everything else (including non-ASCII) is emitted
 * verbatim since the document declares UTF-8. This keeps a prompt containing
 * `<`, `&`, or quotes from injecting markup into the report.
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
 * Render jobs as a single self-contained HTML document — the shareable,
 * browsable counterpart to the live Next.js dashboard. Where the dashboard
 * needs a running server, this is one static file you can open, email, or
 * archive: no external CSS/JS/fonts, no network, theme-aware (honours the
 * viewer's light/dark preference). Columns and cell values are shared with the
 * CSV/Markdown exports ({@link JOB_CSV_COLUMNS} / {@link jobCsvValue}) so all
 * the tabular formats stay in lockstep; the `status` cell additionally gets a
 * `data-status` attribute so the stylesheet can colour it. An empty job list
 * still renders the table header plus an explicit "no jobs" row, so the report
 * is never a confusing blank page.
 */
export function jobsToHtml(jobs: RelayJob[], options: HtmlOptions = {}): string {
  const columns = options.columns ?? JOB_CSV_COLUMNS;
  const title = options.title ?? "AgentRelay job export";
  const safeTitle = escapeHtml(title);

  const head = columns.map((col) => `<th>${escapeHtml(col)}</th>`).join("");

  let body: string;
  if (jobs.length === 0) {
    body = `<tr><td class="empty" colspan="${columns.length}">No jobs to show.</td></tr>`;
  } else {
    body = jobs
      .map((job) => {
        const cells = columns
          .map((col) => {
            const cell = escapeHtml(jobCsvValue(job, col));
            if (col === "status") {
              return `<td class="status" data-status="${escapeHtml(job.status)}">${cell}</td>`;
            }
            return `<td>${cell}</td>`;
          })
          .join("");
        return `<tr>${cells}</tr>`;
      })
      .join("\n");
  }

  const summary = `${jobs.length} job${jobs.length === 1 ? "" : "s"}`;

  // Inline everything so the file is portable and CSP-safe (no external hosts).
  // Colours are declared for light by default and overridden under a dark
  // prefers-color-scheme media query so the report matches the dashboard's
  // theme-aware behaviour.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1a1a1a; --muted: #666; --border: #e2e2e2;
  --header-bg: #f6f6f6; --row-alt: #fafafa;
  --completed: #128a4c; --failed: #c0392b; --cancelled: #8a6d0b; --active: #1f6feb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181d; --fg: #e6e6e6; --muted: #9aa0a6; --border: #2a2d34;
    --header-bg: #1d2026; --row-alt: #1a1c22;
    --completed: #3fb950; --failed: #f85149; --cancelled: #d29922; --active: #58a6ff;
  }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; background: var(--bg); color: var(--fg);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
h1 { font-size: 18px; margin: 0 0 4px; }
.meta { color: var(--muted); margin: 0 0 16px; font-size: 13px; }
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border);
  white-space: nowrap; vertical-align: top; }
th { background: var(--header-bg); font-weight: 600; position: sticky; top: 0; }
tbody tr:nth-child(even) { background: var(--row-alt); }
tbody tr:last-child td { border-bottom: none; }
td.empty { text-align: center; color: var(--muted); padding: 24px; white-space: normal; }
td.status { font-weight: 600; }
td.status[data-status="completed"] { color: var(--completed); }
td.status[data-status="failed"] { color: var(--failed); }
td.status[data-status="cancelled"] { color: var(--cancelled); }
td.status[data-status="queued"],
td.status[data-status="waiting_for_reset"],
td.status[data-status="resuming"] { color: var(--active); }
</style>
</head>
<body>
<h1>${safeTitle}</h1>
<p class="meta">${escapeHtml(summary)}</p>
<div class="table-wrap">
<table>
<thead><tr>${head}</tr></thead>
<tbody>
${body}
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
