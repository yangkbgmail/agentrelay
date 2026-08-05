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

/** True when `name` is one of the recognized CSV/Markdown column names. */
export function isJobCsvColumn(name: string): name is JobCsvColumn {
  return (JOB_CSV_COLUMNS as readonly string[]).includes(name);
}

/**
 * Parse a comma-separated `--columns` list into a validated, ordered column
 * subset for the CSV/Markdown exports. Splits on commas, trims each name, and
 * drops empty tokens (so trailing commas / stray whitespace are forgiven). Every
 * remaining name is checked against {@link JOB_CSV_COLUMNS}: valid ones are kept
 * in the order given (duplicates preserved, so a caller can intentionally repeat
 * a column), and unrecognized ones are collected into `invalid` for the caller
 * to report. Pure — the CLI decides whether an empty result or non-empty
 * `invalid` is an error.
 */
export function parseCsvColumns(input: string): { columns: JobCsvColumn[]; invalid: string[] } {
  const columns: JobCsvColumn[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(",")) {
    const name = raw.trim();
    if (name === "") {
      continue;
    }
    if (isJobCsvColumn(name)) {
      columns.push(name);
    } else {
      invalid.push(name);
    }
  }
  return { columns, invalid };
}

/** Formats that honor a `--columns` subset (the tabular ones). JSON/NDJSON are lossless full-shape and ignore it. */
export const COLUMN_AWARE_FORMATS = ["csv", "md", "html"] as const;

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
 * {@link jobCsvValue}) so all three stay in lockstep and honor the same
 * `--columns` subset. An empty job list still emits the table header plus a
 * "(no jobs)" row so the document is never blank.
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

/**
 * Scalar strings YAML would otherwise read back as a non-string type, so they
 * must be quoted even though they contain only "safe" characters. Compared
 * case-insensitively (YAML 1.1 treats `Yes`, `TRUE`, `Null`, … as their typed
 * values too), which is why the check lower-cases first. `~` is YAML's null.
 */
const YAML_RESERVED_WORDS = new Set([
  "true",
  "false",
  "null",
  "yes",
  "no",
  "on",
  "off",
  "y",
  "n",
  "~",
  "nan",
  ".nan",
  "inf",
  ".inf",
]);

/**
 * True when `s` can be emitted as a YAML plain (unquoted) scalar with no risk of
 * being reparsed as something other than that exact string. We're deliberately
 * conservative: the value must start with an unambiguous letter/digit/`_@/`,
 * contain only characters that are never YAML indicators, not look like a number,
 * and not be a reserved boolean/null word. Anything else (leading `-`, embedded
 * `:`/`#`, whitespace, quotes, an ISO timestamp's colons, …) falls through to the
 * double-quoted form, which is always safe. Quoting a few extra strings costs
 * nothing; emitting an ambiguous plain scalar would silently corrupt a round-trip.
 */
function isPlainYamlScalar(s: string): boolean {
  if (!/^[A-Za-z0-9_@/][A-Za-z0-9_@/.+-]*$/.test(s)) {
    return false;
  }
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) {
    return false;
  }
  return !YAML_RESERVED_WORDS.has(s.toLowerCase());
}

/**
 * Render a string as a YAML scalar: plain when {@link isPlainYamlScalar} allows,
 * otherwise a double-quoted scalar with the C-style escapes YAML's double-quoted
 * style defines (`\\`, `\"`, `\n`, `\r`, `\t`, and `\xNN` for other control
 * characters). Used for both keys and values.
 */
export function yamlScalarString(s: string): string {
  if (s !== "" && isPlainYamlScalar(s)) {
    return s;
  }
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    // Any remaining control character (C0 range minus the ones handled above)
    // must be escaped so the double-quoted scalar stays a single valid line.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the point — they must be \xNN-escaped.
    .replace(/[\x00-\x1f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
  return `"${escaped}"`;
}

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

/** Render a scalar (non-container) YAML value. */
function yamlScalar(value: string | number | boolean | null): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : yamlScalarString(String(value));
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return yamlScalarString(value);
}

function emitYamlMapping(obj: { [key: string]: YamlValue }, indent: number, out: string[]): void {
  const pad = " ".repeat(indent);
  const keys = Object.keys(obj).filter((key) => obj[key] !== undefined);
  if (keys.length === 0) {
    out.push(`${pad}{}`);
    return;
  }
  for (const key of keys) {
    const value = obj[key];
    const k = yamlScalarString(key);
    if (value === null || typeof value !== "object") {
      out.push(`${pad}${k}: ${yamlScalar(value)}`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        out.push(`${pad}${k}: []`);
      } else {
        out.push(`${pad}${k}:`);
        emitYamlSequence(value, indent + 2, out);
      }
    } else {
      out.push(`${pad}${k}:`);
      emitYamlMapping(value, indent + 2, out);
    }
  }
}

function emitYamlSequence(arr: YamlValue[], indent: number, out: string[]): void {
  const pad = " ".repeat(indent);
  for (const item of arr) {
    if (item === null || typeof item !== "object") {
      out.push(`${pad}- ${yamlScalar(item)}`);
    } else if (Array.isArray(item)) {
      if (item.length === 0) {
        out.push(`${pad}- []`);
      } else {
        out.push(`${pad}-`);
        emitYamlSequence(item, indent + 2, out);
      }
    } else {
      // An object entry: hoist its first key onto the "- " line and align the
      // rest under it (the standard compact block-sequence-of-mappings form).
      const childIndent = indent + 2;
      const lines: string[] = [];
      emitYamlMapping(item, childIndent, lines);
      lines[0] = `${pad}- ${lines[0].slice(childIndent)}`;
      out.push(...lines);
    }
  }
}

/**
 * Serialize jobs to YAML — a lossless, human-readable full-shape export (the
 * counterpart to {@link jobsToJson}). Like JSON/NDJSON it preserves the entire
 * {@link RelayJob} structure (the `command` array, `lastOutputTail`, and the
 * nested `lastRateLimit` provenance), so it round-trips through any YAML parser,
 * but it reads far more naturally when checked into a repo or eyeballed in a
 * diff. Dependency-free: a small block-style emitter with conservative scalar
 * quoting, no `js-yaml`. An empty job list yields `[]` (a valid empty YAML
 * sequence) rather than a blank file, mirroring the other exports' "schema is
 * visible" behavior. No trailing newline (the CLI file writer adds it).
 */
export function jobsToYaml(jobs: RelayJob[]): string {
  if (jobs.length === 0) {
    return "[]";
  }
  const out: string[] = [];
  emitYamlSequence(jobs as unknown as YamlValue[], 0, out);
  return out.join("\n");
}

/** Supported export formats. */
export const EXPORT_FORMATS = ["csv", "json", "md", "ndjson", "html", "yaml"] as const;
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
    case "yaml":
      return jobsToYaml(jobs);
    default:
      return jobsToCsv(jobs, options);
  }
}
