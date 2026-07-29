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

/** One line of a multi-line log that the parser would treat as a rate limit. */
export interface ScanLineMatch {
  /** 1-based line number within the scanned text. */
  line: number;
  /** The source line (trailing CR stripped), so the user can see what matched. */
  text: string;
  resetAt: string;
  rawMatch: string;
  pattern: string;
}

/**
 * The outcome of scanning a multi-line log line-by-line. Unlike `buildParseReport`
 * (which runs the parser once over the whole blob and returns only the first hit),
 * this reports *every* line that would trip a detection, with its line number —
 * the diagnostic for "which line of my captured session, if any, would have queued
 * a resume?". In real operation AgentRelay acts on the first matching line, exposed
 * here as `actsOnLine`.
 */
export interface ScanReport {
  tool: AgentTool;
  /** Total number of lines scanned. */
  totalLines: number;
  matches: ScanLineMatch[];
  /** Line number AgentRelay would act on (the first match), or null if none. */
  actsOnLine: number | null;
}

/**
 * Scan `text` line-by-line with the given tool's adapter, collecting every line
 * that the rate-limit parser matches. Pure: a single `now` is resolved once and
 * reused for all lines so relative durations ("try again in 1h") resolve
 * consistently and the result is deterministic under an injected clock.
 */
export function buildScanReport(text: string, options: { tool?: AgentTool; now?: Date } = {}): ScanReport {
  const adapter = resolveAdapter({ tool: options.tool });
  const now = options.now ?? new Date();
  const lines = text.split("\n");
  // Drop a trailing empty element produced by a final newline so an N-line log
  // that ends in "\n" reports N lines, not N+1.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const matches: ScanLineMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    const info = adapter.detectRateLimit(line, { now });
    if (info) {
      matches.push({ line: i + 1, text: line, resetAt: info.resetAt, rawMatch: info.rawMatch, pattern: info.pattern });
    }
  }
  return {
    tool: adapter.tool,
    totalLines: lines.length,
    matches,
    actsOnLine: matches.length > 0 ? matches[0].line : null,
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
 * Render a scan report as a human-readable block. Pure aside from `now`
 * defaulting (used only for the per-line countdown). `color` gates ANSI codes.
 */
export function renderScanReport(report: ScanReport, options: { now?: number; color?: boolean } = {}): string {
  const color = options.color ?? false;
  const now = options.now ?? Date.now();
  const lineWord = report.totalLines === 1 ? "line" : "lines";

  if (report.matches.length === 0) {
    return [
      paint(YELLOW, `No rate-limit lines detected across ${report.totalLines} ${lineWord}.`, color),
      paint(DIM, `AgentRelay would let this output exit normally (adapter: ${report.tool}).`, color),
    ].join("\n");
  }

  const header = `${paint(GREEN, `Detected ${report.matches.length} rate-limit ${report.matches.length === 1 ? "line" : "lines"}`, color)} ${paint(DIM, `of ${report.totalLines} scanned (adapter: ${report.tool})`, color)}`;
  const lines = [header];
  for (const m of report.matches) {
    const countdown = formatCountdown(m.resetAt, now);
    const marker = m.line === report.actsOnLine ? paint(GREEN, "→", color) : " ";
    lines.push(
      `${marker} ${paint(BOLD, `line ${m.line}`, color)} ${paint(DIM, `[${m.pattern}]`, color)} resets ${m.resetAt} ${paint(DIM, `(in ${countdown})`, color)}`
    );
    lines.push(`    ${paint(DIM, m.text.trim(), color)}`);
  }
  lines.push(paint(DIM, `AgentRelay would act on the first match (line ${report.actsOnLine}).`, color));
  return lines.join("\n");
}

/**
 * Render a scan report as JSON (machine-readable). Each match carries `resetInMs`
 * (ms until its reset time) so callers don't re-parse the ISO string.
 */
export function renderScanReportJson(report: ScanReport, options: { now?: number } = {}): string {
  const now = options.now ?? Date.now();
  const matches = report.matches.map((m) => {
    const target = new Date(m.resetAt).getTime();
    return { ...m, resetInMs: Number.isNaN(target) ? null : target - now };
  });
  return JSON.stringify({ ...report, matches }, null, 2);
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
