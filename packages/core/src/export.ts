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
 * Escape a value for HTML text/attribute context: the five characters that are
 * special in HTML (`&`, `<`, `>`, `"`, `'`) become their named/numeric entities.
 * `&` is replaced first so the ampersands introduced by the later replacements
 * aren't double-escaped. Used by {@link jobsToHtml} so command lines and error
 * text that contain markup can never break out of a table cell.
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
 * Escape a job field for one HTML table cell: HTML-escape it, then turn newlines
 * into `<br>` so multi-line prompts/errors stay inside their cell, and render an
 * empty value as an em dash so a blank reads as "no value" rather than a gap
 * (matching {@link escapeMarkdownCell}'s convention).
 */
export function escapeHtmlCell(value: string): string {
  if (value === "") {
    return "&mdash;";
  }
  return escapeHtml(value).replace(/\r\n|\r|\n/g, "<br>");
}

export interface HtmlOptions extends Pick<CsvOptions, "columns"> {
  /** Document `<title>` / heading. Defaults to "AgentRelay job export". */
  title?: string;
}

/**
 * Render jobs as a standalone, self-contained HTML document — the counterpart to
 * the Markdown export (which is meant for pasting into an already-rendered
 * context). This one you double-click to open in a browser or attach to a
 * report: a full `<!doctype html>` page with inline CSS (no external requests),
 * a light/dark-aware theme, and status cells colour-coded by state. Columns and
 * cell values are shared with the CSV/Markdown exports ({@link JOB_CSV_COLUMNS} /
 * {@link jobCsvValue}) so all three stay in lockstep. An empty job list still
 * emits the table header plus an "(no jobs)" row so the document is never blank.
 */
export function jobsToHtml(jobs: RelayJob[], options: HtmlOptions = {}): string {
  const columns = options.columns ?? JOB_CSV_COLUMNS;
  const title = escapeHtml(options.title ?? "AgentRelay job export");
  const head = `<thead><tr>${columns.map((col) => `<th>${escapeHtml(col)}</th>`).join("")}</tr></thead>`;

  let body: string;
  if (jobs.length === 0) {
    body = `<tbody><tr><td class="empty" colspan="${columns.length}">(no jobs)</td></tr></tbody>`;
  } else {
    const rows = jobs.map((job) => {
      const cells = columns.map((col) => {
        const cell = escapeHtmlCell(jobCsvValue(job, col));
        // The status column carries a class so CSS can colour-code the state.
        return col === "status"
          ? `<td class="status status-${escapeHtml(job.status)}">${cell}</td>`
          : `<td>${cell}</td>`;
      });
      return `<tr>${cells.join("")}</tr>`;
    });
    body = `<tbody>${rows.join("")}</tbody>`;
  }

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    "<style>",
    ":root{color-scheme:light dark}",
    "body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:2rem;color:#1a1a1a;background:#fff}",
    "h1{font-size:1.25rem;margin:0 0 1rem}",
    "table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}",
    "th,td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left;vertical-align:top}",
    "th{background:#f5f5f5;font-weight:600;white-space:nowrap}",
    "tbody tr:nth-child(even){background:#fafafa}",
    "td.empty{text-align:center;color:#888;font-style:italic}",
    ".status{font-weight:600;white-space:nowrap}",
    ".status-completed{color:#137333}",
    ".status-failed{color:#c5221f}",
    ".status-cancelled{color:#8a8a8a}",
    ".status-waiting_for_reset,.status-resuming{color:#b06000}",
    ".status-queued{color:#1a56c4}",
    "@media(prefers-color-scheme:dark){",
    "body{color:#e6e6e6;background:#1a1a1a}",
    "th,td{border-color:#3a3a3a}",
    "th{background:#262626}",
    "tbody tr:nth-child(even){background:#222}",
    ".status-completed{color:#5bd07f}",
    ".status-failed{color:#ff6b64}",
    ".status-cancelled{color:#9a9a9a}",
    ".status-waiting_for_reset,.status-resuming{color:#e0a458}",
    ".status-queued{color:#6ea8ff}",
    "}",
    "</style>",
    "</head>",
    "<body>",
    `<h1>${title}</h1>`,
    `<table>${head}${body}</table>`,
    "</body>",
    "</html>",
  ].join("\n");
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
