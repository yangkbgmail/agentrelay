// Rendering + detection glue for `agentrelay parse` — a diagnostic that runs the
// rate-limit parser against a message so users can see, *without running a job*,
// whether AgentRelay would detect a limit, which pattern matched, and when it
// would resume. Kept as pure functions here (no stdin/clock unless injected),
// separate from the commander wiring in cli.ts, so the exact output is testable.

import type { AgentTool, RateLimitInfo } from "@agentrelay/core";
import { resolveAdapter } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/**
 * The outcome of parsing one message: which adapter's patterns were used, and —
 * when a limit was detected — the reset time, the raw substring that matched,
 * and the named pattern that produced it. `matched: false` with all-null fields
 * means AgentRelay would treat the command as a normal (non-rate-limited) exit.
 */
export interface ParseReport {
  /** The adapter actually used (after resolving `--tool` → generic default). */
  tool: AgentTool;
  matched: boolean;
  resetAt: string | null;
  rawMatch: string | null;
  pattern: string | null;
}

/**
 * Run the rate-limit parser against `text` using the given tool's adapter
 * (its extra patterns are tried before the generic ones). Pure: the only
 * ambient input is `options.now`, which defaults inside the core parser when
 * omitted — pass it for deterministic tests.
 */
export function buildParseReport(text: string, options: { tool?: AgentTool; now?: Date } = {}): ParseReport {
  const adapter = resolveAdapter({ tool: options.tool });
  const info: RateLimitInfo | null = adapter.detectRateLimit(text, options.now ? { now: options.now } : {});
  return {
    tool: adapter.tool,
    matched: info !== null,
    resetAt: info?.resetAt ?? null,
    rawMatch: info?.rawMatch ?? null,
    pattern: info?.pattern ?? null,
  };
}

function paint(code: string, cell: string, color: boolean): string {
  return color ? `${code}${cell}${RESET}` : cell;
}

/**
 * Render a report as a human-readable block. Pure: no I/O, no ambient clock
 * unless `now` is omitted (used only for the reset countdown). `color` gates
 * ANSI codes (TTY only).
 */
export function renderParseReport(report: ParseReport, options: { now?: number; color?: boolean } = {}): string {
  const color = options.color ?? false;
  const now = options.now ?? Date.now();

  if (!report.matched) {
    return [
      paint(YELLOW, "No rate-limit detected.", color),
      paint(DIM, `AgentRelay would let this command exit normally (adapter: ${report.tool}).`, color),
    ].join("\n");
  }

  const countdown = formatCountdown(report.resetAt, now);
  const lines = [
    `${paint(GREEN, "Rate limit detected", color)} ${paint(DIM, `(adapter: ${report.tool})`, color)}`,
    `  ${paint(BOLD, "pattern:", color)}  ${report.pattern}`,
    `  ${paint(BOLD, "matched:", color)}  ${JSON.stringify(report.rawMatch)}`,
    `  ${paint(BOLD, "resets:", color)}   ${report.resetAt} ${paint(DIM, `(in ${countdown})`, color)}`,
  ];
  return lines.join("\n");
}

/**
 * Render a report as JSON (machine-readable, for scripts/jq). Adds `resetInMs`
 * (ms until the reset time, or null when no match / unparseable) so callers
 * don't re-parse the ISO string. Pure aside from `now` defaulting.
 */
export function renderParseReportJson(report: ParseReport, options: { now?: number } = {}): string {
  const now = options.now ?? Date.now();
  let resetInMs: number | null = null;
  if (report.resetAt) {
    const target = new Date(report.resetAt).getTime();
    if (!Number.isNaN(target)) resetInMs = target - now;
  }
  return JSON.stringify({ ...report, resetInMs }, null, 2);
}

/**
 * One detected line from a multi-line scan (`agentrelay parse --scan`). The
 * default `parse` collapses all input into a single message and reports only
 * the *first* match anywhere; scanning instead runs the parser per line so a
 * whole agent log can be checked at once — answering "which lines would
 * AgentRelay catch, with which pattern?".
 */
export interface ScanMatch {
  /** 1-indexed line number in the original input. */
  line: number;
  /** Name of the parser pattern that matched this line. */
  pattern: string;
  /** ISO reset timestamp this line's detection produced. */
  resetAt: string;
  /** The raw substring of the line that matched. */
  rawMatch: string;
}

/** Per-pattern hit count across a scan, ranked by count (desc), name (asc). */
export interface ScanPatternCount {
  pattern: string;
  count: number;
}

/**
 * Result of scanning multi-line text line-by-line with one tool's adapter.
 * `scannedLines` counts only non-blank lines (blank lines can never match and
 * would inflate the denominator), so `matches.length / scannedLines` is a
 * meaningful detection rate.
 */
export interface ScanReport {
  /** The adapter actually used (after resolving `--tool` → generic default). */
  tool: AgentTool;
  /** Non-blank lines the parser was run against. */
  scannedLines: number;
  /** One entry per line that produced a detection, in input order. */
  matches: ScanMatch[];
  /** Frequency table of the patterns that fired, most-common first. */
  byPattern: ScanPatternCount[];
}

/**
 * Scan `text` line-by-line, running the rate-limit parser on each non-blank
 * line with the given tool's adapter. Pure: the only ambient input is
 * `options.now` (forwarded to the parser for deterministic reset resolution).
 * Lines are split on `\r?\n`; a line that is empty or whitespace-only is
 * skipped entirely (never counted, never parsed).
 */
export function buildScanReport(text: string, options: { tool?: AgentTool; now?: Date } = {}): ScanReport {
  const adapter = resolveAdapter({ tool: options.tool });
  const matches: ScanMatch[] = [];
  const counts = new Map<string, number>();
  let scannedLines = 0;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    scannedLines++;
    const info: RateLimitInfo | null = adapter.detectRateLimit(raw, options.now ? { now: options.now } : {});
    if (!info) continue;
    matches.push({ line: i + 1, pattern: info.pattern, resetAt: info.resetAt, rawMatch: info.rawMatch });
    counts.set(info.pattern, (counts.get(info.pattern) ?? 0) + 1);
  }

  const byPattern: ScanPatternCount[] = [...counts.entries()]
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));

  return { tool: adapter.tool, scannedLines, matches, byPattern };
}

/**
 * Render a scan report as a human-readable block: one line per detection
 * (`L<line>  <pattern>  resets <count>  "<matched text>"`) plus a summary
 * footer. Pure aside from `now` defaulting (used for each reset countdown).
 */
export function renderScanReport(report: ScanReport, options: { now?: number; color?: boolean } = {}): string {
  const color = options.color ?? false;
  const now = options.now ?? Date.now();

  if (report.scannedLines === 0) {
    return paint(YELLOW, "No lines to scan (input was empty).", color);
  }

  if (report.matches.length === 0) {
    return [
      paint(YELLOW, `No rate limits detected across ${report.scannedLines} line(s).`, color),
      paint(DIM, `AgentRelay would let all of this output exit normally (adapter: ${report.tool}).`, color),
    ].join("\n");
  }

  const lineWidth = Math.max(...report.matches.map((m) => `L${m.line}`.length));
  const patternWidth = Math.max(...report.matches.map((m) => m.pattern.length));
  const rows = report.matches.map((m) => {
    const lineCell = paint(DIM, `L${m.line}`.padEnd(lineWidth), color);
    const patternCell = paint(GREEN, m.pattern.padEnd(patternWidth), color);
    const countdown = formatCountdown(m.resetAt, now);
    const resets = paint(DIM, `resets ${countdown}`, color);
    return `  ${lineCell}  ${patternCell}  ${resets}  ${JSON.stringify(m.rawMatch)}`;
  });

  const patternSummary = report.byPattern.map((p) => `${p.pattern} ×${p.count}`).join(", ");
  const footer = paint(
    BOLD,
    `${report.matches.length} detection(s) across ${report.scannedLines} line(s) (adapter: ${report.tool})`,
    color
  );
  return [...rows, "", footer, paint(DIM, `  by pattern: ${patternSummary}`, color)].join("\n");
}

/**
 * Render a scan report as JSON (machine-readable, for scripts/jq). Each match
 * gains `resetInMs` (ms until its reset, or null when unparseable) so callers
 * don't re-parse the ISO strings. Pure aside from `now` defaulting.
 */
export function renderScanReportJson(report: ScanReport, options: { now?: number } = {}): string {
  const now = options.now ?? Date.now();
  const matches = report.matches.map((m) => {
    const target = new Date(m.resetAt).getTime();
    const resetInMs = Number.isNaN(target) ? null : target - now;
    return { ...m, resetInMs };
  });
  return JSON.stringify({ ...report, matches }, null, 2);
}
