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
 * Escape a value for safe interpolation into HTML text/attribute context. The
 * five characters that can break out of an element body or a double-quoted
 * attribute (`&`, `<`, `>`, `"`, `'`) are turned into their entities; `&` is
 * replaced first so the ampersands introduced by the later replacements aren't
 * double-escaped. Everything else — including newlines, which stay as-is and are
 * rendered via `white-space: pre-wrap` in the report — passes through verbatim.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Count jobs per status, preserving first-encounter order. Feeds the summary
 * chips at the top of the HTML report so a reader sees the queue's shape (how
 * many completed / failed / waiting) before scanning the table. Kept tiny and
 * local rather than pulling in {@link computeStats} — the report only needs the
 * per-status tally, and staying dependency-free keeps this module pure string-in
 * string-out.
 */
export function countByStatus(jobs: RelayJob[]): Array<{ status: string; count: number }> {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    counts.set(job.status, (counts.get(job.status) ?? 0) + 1);
  }
  return [...counts].map(([status, count]) => ({ status, count }));
}

export interface HtmlOptions extends Pick<CsvOptions, "columns"> {
  /** Heading shown at the top of the report. Defaults to "AgentRelay — Job Export". */
  title?: string;
}

/**
 * Render jobs as a single self-contained HTML document — the browser-friendly
 * counterpart to the Markdown export. Where `md` is meant for pasting into an
 * issue and CSV/JSON for tooling, this is a report you can double-click open or
 * hand to someone who doesn't live in a terminal: a summary header (total +
 * per-status chips) over a styled table, with all CSS inlined so the file works
 * offline and with no external assets. It adapts to light/dark via
 * `prefers-color-scheme`. Columns/cell values are shared with the CSV/Markdown
 * exports ({@link JOB_CSV_COLUMNS} / {@link jobCsvValue}) so the three stay in
 * lockstep; every value is HTML-escaped ({@link escapeHtml}) so a `<`, `&`, or a
 * quote in a prompt or error can't break the markup. An empty job list still
 * renders the header and an empty-state row so the report's schema is visible.
 */
export function jobsToHtml(jobs: RelayJob[], options: HtmlOptions = {}): string {
  const columns = options.columns ?? JOB_CSV_COLUMNS;
  const title = options.title ?? "AgentRelay — Job Export";
  const safeTitle = escapeHtml(title);

  const chips = countByStatus(jobs)
    .map(({ status, count }) => {
      const s = escapeHtml(status);
      return `<span class="chip chip-${s}">${s}<b>${count}</b></span>`;
    })
    .join("");

  const headCells = columns.map((col) => `<th>${escapeHtml(col)}</th>`).join("");

  const bodyRows =
    jobs.length === 0
      ? `<tr><td class="empty-row" colspan="${columns.length}">No jobs to display.</td></tr>`
      : jobs
          .map((job) => {
            const cells = columns
              .map((col) => {
                const raw = jobCsvValue(job, col);
                if (raw === "") {
                  return '<td><span class="empty">—</span></td>';
                }
                const value = escapeHtml(raw);
                if (col === "status") {
                  return `<td><span class="status status-${value}">${value}</span></td>`;
                }
                return `<td>${value}</td>`;
              })
              .join("");
            return `<tr>${cells}</tr>`;
          })
          .join("");

  const jobCount = jobs.length;
  const jobLabel = jobCount === 1 ? "job" : "jobs";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1a1a1a; --muted: #6b7280;
  --border: #e5e7eb; --head: #f9fafb; --row: #ffffff; --row-alt: #f9fafb; --chip: #f3f4f6; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0f1115; --fg: #e5e7eb; --muted: #9ca3af; --border: #2a2f3a;
    --head: #161a22; --row: #0f1115; --row-alt: #141821; --chip: #1c222c; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem 1.5rem; background: var(--bg); color: var(--fg);
  font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
.meta { color: var(--muted); margin: 0 0 1rem; }
.chips { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0 0 1.25rem; }
.chip { background: var(--chip); border: 1px solid var(--border); border-radius: 999px;
  padding: 0.2rem 0.7rem; font-size: 0.85rem; }
.chip b { margin-left: 0.4rem; font-variant-numeric: tabular-nums; }
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border);
  vertical-align: top; white-space: pre-wrap; word-break: break-word; }
th { background: var(--head); position: sticky; top: 0; font-weight: 600; }
tbody tr:nth-child(even) { background: var(--row-alt); }
tbody tr:nth-child(odd) { background: var(--row); }
td.empty-row { text-align: center; color: var(--muted); padding: 1.5rem; }
.empty { color: var(--muted); }
.status { font-weight: 600; }
.status-completed { color: #16a34a; }
.status-failed { color: #dc2626; }
.status-cancelled { color: #9ca3af; }
.status-queued, .status-resuming { color: #2563eb; }
.status-waiting_for_reset { color: #d97706; }
</style>
</head>
<body>
<h1>${safeTitle}</h1>
<p class="meta">${jobCount} ${jobLabel}</p>
<div class="chips">${chips}</div>
<div class="table-wrap">
<table>
<thead><tr>${headCells}</tr></thead>
<tbody>${bodyRows}</tbody>
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
