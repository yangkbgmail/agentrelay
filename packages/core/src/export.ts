import { computeStats } from "./stats.js";
import type { JobStatus, RelayJob } from "./types.js";

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
 * Escape a value for safe interpolation into HTML text or a double-quoted
 * attribute. Job fields (`command`, `lastError`, `project`, …) are arbitrary
 * user/agent strings, so an un-escaped `<script>` in a prompt or a stray `<`
 * in an error must never break out into markup — this keeps the report inert
 * regardless of what a job captured. The five characters `& < > " '` cover both
 * element content and quoted attributes.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Status order for the report table/legend — active states first, then terminal. */
const HTML_STATUS_ORDER: JobStatus[] = ["queued", "waiting_for_reset", "resuming", "completed", "failed", "cancelled"];

/** Columns rendered in the HTML report table, sharing values with the CSV export. */
const HTML_TABLE_COLUMNS: JobCsvColumn[] = [
  "id",
  "project",
  "tool",
  "status",
  "attempts",
  "resetAt",
  "createdAt",
  "updatedAt",
  "command",
  "lastError",
];

export interface HtmlOptions {
  /**
   * Timestamp shown in the report header ("Generated …"). Pass an ISO string
   * (e.g. `new Date().toISOString()`) from the CLI; omitted here so the pure
   * serializer stays deterministic and testable — no header line is rendered
   * when absent.
   */
  generatedAt?: string;
}

/**
 * Render the job store as a single self-contained HTML document — a shareable,
 * offline report you can open in a browser without starting the Next.js
 * dashboard. Unlike CSV/JSON/NDJSON (machine formats) and Markdown (paste into
 * an issue), this is the "hand someone a file they can just look at" export:
 * inline CSS only (no external assets, no JS), light/dark aware via
 * `prefers-color-scheme`, a summary header reusing {@link computeStats}, and a
 * status-colored table. Pure and non-mutating — the CLI decides where the bytes
 * go. Every interpolated value passes through {@link escapeHtml}, so arbitrary
 * job content can't inject markup. An empty job list still yields a valid
 * document with an explicit "No jobs" note.
 */
export function jobsToHtml(jobs: RelayJob[], options: HtmlOptions = {}): string {
  const stats = computeStats(jobs);
  const successRate = stats.successRate === null ? "—" : `${Math.round(stats.successRate * 1000) / 10}%`;

  const summaryCards = [
    { label: "Total", value: String(stats.total) },
    { label: "Active", value: String(stats.active) },
    { label: "Terminal", value: String(stats.terminal) },
    { label: "Success rate", value: successRate },
    { label: "Retried", value: String(stats.retriedJobs) },
  ]
    .map(
      (card) =>
        `      <div class="card"><div class="card-value">${escapeHtml(card.value)}</div>` +
        `<div class="card-label">${escapeHtml(card.label)}</div></div>`
    )
    .join("\n");

  // Only render status chips that actually occur, in a stable order.
  const statusChips = HTML_STATUS_ORDER.filter((s) => stats.byStatus[s] > 0)
    .map((s) => `      <span class="chip status-${s}">${escapeHtml(s)} <b>${stats.byStatus[s]}</b></span>`)
    .join("\n");

  const headerRow = `        <tr>${HTML_TABLE_COLUMNS.map((col) => `<th>${escapeHtml(col)}</th>`).join("")}</tr>`;

  const bodyRows =
    jobs.length === 0
      ? `        <tr><td class="empty" colspan="${HTML_TABLE_COLUMNS.length}">No jobs in the store yet.</td></tr>`
      : jobs
          .map((job) => {
            const cells = HTML_TABLE_COLUMNS.map((col) => {
              const raw = jobCsvValue(job, col);
              if (col === "status") {
                return `<td><span class="chip status-${escapeHtml(job.status)}">${escapeHtml(raw)}</span></td>`;
              }
              const cls = col === "command" || col === "lastError" ? ' class="wrap"' : "";
              return `<td${cls}>${raw === "" ? "—" : escapeHtml(raw)}</td>`;
            }).join("");
            return `        <tr>${cells}</tr>`;
          })
          .join("\n");

  const generatedLine = options.generatedAt
    ? `\n    <p class="meta">Generated ${escapeHtml(options.generatedAt)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentRelay — Job Report</title>
  <style>
    :root {
      --bg: #ffffff; --fg: #1a1a1a; --muted: #6b7280; --border: #e5e7eb;
      --card: #f9fafb; --accent: #2563eb;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f1115; --fg: #e5e7eb; --muted: #9ca3af; --border: #2a2f3a;
        --card: #171a21; --accent: #60a5fa;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 2rem 1.25rem; background: var(--bg); color: var(--fg);
      font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .wrap-page { max-width: 1100px; margin: 0 auto; }
    h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
    h1 span { color: var(--accent); }
    .meta { color: var(--muted); margin: 0 0 1.5rem; font-size: .85rem; }
    .cards { display: flex; flex-wrap: wrap; gap: .75rem; margin-bottom: 1rem; }
    .card {
      background: var(--card); border: 1px solid var(--border); border-radius: 10px;
      padding: .75rem 1rem; min-width: 110px; flex: 1 1 auto;
    }
    .card-value { font-size: 1.5rem; font-weight: 700; }
    .card-label { color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; }
    .chips { display: flex; flex-wrap: wrap; gap: .4rem; margin-bottom: 1.5rem; }
    .chip {
      display: inline-block; padding: .1rem .5rem; border-radius: 999px;
      font-size: .8rem; border: 1px solid var(--border); white-space: nowrap;
    }
    .chip b { font-weight: 700; }
    .status-completed { background: #16a34a22; color: #16a34a; border-color: #16a34a55; }
    .status-failed { background: #dc262622; color: #ef4444; border-color: #dc262655; }
    .status-cancelled { background: #6b728022; color: var(--muted); border-color: var(--border); }
    .status-queued, .status-resuming { background: #2563eb22; color: var(--accent); border-color: #2563eb55; }
    .status-waiting_for_reset { background: #d9770622; color: #f59e0b; border-color: #d9770655; }
    .table-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; }
    table { border-collapse: collapse; width: 100%; font-size: .85rem; }
    th, td { text-align: left; padding: .5rem .65rem; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { position: sticky; top: 0; background: var(--card); font-weight: 600; white-space: nowrap; }
    tr:last-child td { border-bottom: none; }
    td.wrap { max-width: 320px; overflow-wrap: anywhere; }
    td.empty { text-align: center; color: var(--muted); padding: 1.5rem; }
    code, td { font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <div class="wrap-page">
    <h1>Agent<span>Relay</span> — Job Report</h1>${generatedLine}
    <div class="cards">
${summaryCards}
    </div>
    <div class="chips">
${statusChips}
    </div>
    <div class="table-scroll">
      <table>
        <thead>
${headerRow}
        </thead>
        <tbody>
${bodyRows}
        </tbody>
      </table>
    </div>
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
      return jobsToHtml(jobs);
    default:
      return jobsToCsv(jobs, options);
  }
}
