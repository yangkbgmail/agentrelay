// Rendering + detection glue for `agentrelay parse` — a diagnostic that runs the
// rate-limit parser against a message so users can see, *without running a job*,
// whether AgentRelay would detect a limit, which pattern matched, and when it
// would resume. Kept as pure functions here (no stdin/clock unless injected),
// separate from the commander wiring in cli.ts, so the exact output is testable.

import type { AgentTool, RateLimitInfo, ScanResult } from "@agentrelay/core";
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

/** Cap a raw match so a single long log line doesn't dominate the scan output. */
function truncate(text: string, max = 72): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Render a scan (`parse --scan`) as a human-readable block: a pattern-frequency
 * table followed by one line per detection with its line number, reset, and
 * countdown. Pure: no I/O, ambient clock only via `now` default (for the
 * countdown). `color` gates ANSI codes (TTY only).
 */
export function renderScanReport(result: ScanResult, options: { now?: number; color?: boolean } = {}): string {
  const color = options.color ?? false;
  const now = options.now ?? Date.now();
  const adapterNote = paint(DIM, `(adapter: ${result.tool})`, color);

  if (result.matchedLines === 0) {
    const lineWord = result.totalLines === 1 ? "line" : "lines";
    return [
      paint(YELLOW, `No rate limits detected in ${result.totalLines} ${lineWord}.`, color),
      paint(DIM, `AgentRelay would let this output exit normally (adapter: ${result.tool}).`, color),
    ].join("\n");
  }

  const hitWord = result.matchedLines === 1 ? "detection" : "detections";
  const lineWord = result.totalLines === 1 ? "line" : "lines";
  const lines: string[] = [
    `${paint(GREEN, `Found ${result.matchedLines} ${hitWord}`, color)} in ${result.totalLines} ${lineWord} ${adapterNote}`,
    "",
    paint(BOLD, "Patterns:", color),
  ];
  for (const p of result.patterns) {
    lines.push(`  ${p.pattern.padEnd(24)} ${paint(DIM, `× ${p.count}`, color)}`);
  }
  lines.push("");
  lines.push(paint(BOLD, "Detections:", color));
  for (const m of result.matches) {
    const countdown = formatCountdown(m.resetAt, now);
    const loc = paint(DIM, `L${m.line}`, color);
    lines.push(`  ${loc} ${paint(BOLD, m.pattern, color)} → ${m.resetAt} ${paint(DIM, `(in ${countdown})`, color)}`);
    lines.push(`     ${paint(DIM, JSON.stringify(truncate(m.rawMatch)), color)}`);
  }
  return lines.join("\n");
}

/**
 * Render a scan as JSON (machine-readable, for scripts/jq). Adds `resetInMs` to
 * each match (ms until its reset, or null when unparseable). Pure aside from the
 * `now` default.
 */
export function renderScanReportJson(result: ScanResult, options: { now?: number } = {}): string {
  const now = options.now ?? Date.now();
  const matches = result.matches.map((m) => {
    const target = new Date(m.resetAt).getTime();
    const resetInMs = Number.isNaN(target) ? null : target - now;
    return { ...m, resetInMs };
  });
  return JSON.stringify({ ...result, matches }, null, 2);
}
