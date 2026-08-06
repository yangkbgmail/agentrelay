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
  return JSON.stringify(reportToJson(report, now), null, 2);
}

function reportToJson(report: ParseReport, now: number): ParseReport & { resetInMs: number | null } {
  let resetInMs: number | null = null;
  if (report.resetAt) {
    const target = new Date(report.resetAt).getTime();
    if (!Number.isNaN(target)) resetInMs = target - now;
  }
  return { ...report, resetInMs };
}

// --- Batch mode -------------------------------------------------------------
// `agentrelay parse --file corpus.txt` (or `--batch` over stdin) runs the parser
// against many candidate messages at once — one per non-blank line — and reports
// a match-rate summary plus a per-pattern breakdown. This turns the single-message
// diagnostic into a *corpus tester*: collect real rate-limit console dumps into a
// file (`grep -i limit *.log >> corpus.txt`) and validate, in one shot, that the
// parser still recognises every format — a regression gate for parser changes.

/** One line of a batch parse: its 1-based source line number, the trimmed text, and the report. */
export interface BatchParseEntry {
  line: number;
  text: string;
  report: ParseReport;
}

/** A pattern's hit count across the corpus (ranked count desc, then name asc). */
export interface BatchPatternStat {
  pattern: string;
  count: number;
}

/** Aggregate outcome of a batch parse. `matchRate` is null only when nothing was parsed. */
export interface BatchParseSummary {
  tool: AgentTool;
  total: number;
  matched: number;
  unmatched: number;
  matchRate: number | null;
  byPattern: BatchPatternStat[];
}

export interface BatchParseResult {
  entries: BatchParseEntry[];
  summary: BatchParseSummary;
}

/**
 * Parse every non-blank line of `input` as its own candidate message. Blank /
 * whitespace-only lines are skipped (and don't count toward totals) but line
 * numbers stay faithful to the source so failures are easy to locate. Pure: the
 * only ambient input is `options.now` (used for the resolved reset countdown),
 * which defaults inside the core parser when omitted — pass it for deterministic
 * tests.
 */
export function buildBatchParseReport(input: string, options: { tool?: AgentTool; now?: Date } = {}): BatchParseResult {
  const adapter = resolveAdapter({ tool: options.tool });
  const entries: BatchParseEntry[] = [];
  const patternCounts = new Map<string, number>();
  let matched = 0;

  const lines = input.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (text === "") continue;
    const report = buildParseReport(text, { tool: options.tool, now: options.now });
    entries.push({ line: i + 1, text, report });
    if (report.matched) {
      matched++;
      if (report.pattern) patternCounts.set(report.pattern, (patternCounts.get(report.pattern) ?? 0) + 1);
    }
  }

  const total = entries.length;
  const byPattern = [...patternCounts.entries()]
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));

  return {
    entries,
    summary: {
      tool: adapter.tool,
      total,
      matched,
      unmatched: total - matched,
      matchRate: total === 0 ? null : matched / total,
      byPattern,
    },
  };
}

function formatRate(rate: number | null): string {
  if (rate === null) return "n/a";
  return `${Math.round(rate * 100)}%`;
}

/**
 * Render a batch result as a human-readable block: one line per parsed message
 * (✓/· marker, line number, pattern, reset countdown, truncated text) followed
 * by a summary footer and a per-pattern breakdown. Pure: no I/O, `now` only
 * feeds the countdown; `color` gates ANSI codes.
 */
export function renderBatchParseReport(
  result: BatchParseResult,
  options: { now?: number; color?: boolean } = {}
): string {
  const color = options.color ?? false;
  const now = options.now ?? Date.now();
  const { entries, summary } = result;

  if (entries.length === 0) {
    return paint(YELLOW, "No messages to parse (input was empty or blank).", color);
  }

  const lines: string[] = [];
  for (const entry of entries) {
    const preview = entry.text.length > 60 ? `${entry.text.slice(0, 57)}...` : entry.text;
    if (entry.report.matched) {
      const countdown = formatCountdown(entry.report.resetAt, now);
      lines.push(
        `${paint(GREEN, "✓", color)} ${paint(DIM, `L${entry.line}`, color)} ` +
          `${paint(BOLD, entry.report.pattern ?? "?", color)} ` +
          `${paint(DIM, `resets in ${countdown}`, color)}`
      );
    } else {
      lines.push(
        `${paint(YELLOW, "·", color)} ${paint(DIM, `L${entry.line}`, color)} ${paint(DIM, "no match", color)}`
      );
    }
    lines.push(paint(DIM, `    ${JSON.stringify(preview)}`, color));
  }

  lines.push("");
  lines.push(
    `${paint(BOLD, "Summary:", color)} ${summary.total} message(s) · ` +
      `${paint(GREEN, `${summary.matched} matched`, color)} (${formatRate(summary.matchRate)}) · ` +
      `${summary.unmatched} unmatched ${paint(DIM, `(adapter: ${summary.tool})`, color)}`
  );
  if (summary.byPattern.length > 0) {
    lines.push(paint(BOLD, "By pattern:", color));
    for (const stat of summary.byPattern) {
      lines.push(`  ${stat.pattern.padEnd(24)} ${paint(DIM, String(stat.count), color)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Render a batch result as JSON (machine-readable). Each entry carries its line
 * number, text, the full report and `resetInMs`; the summary carries the totals
 * and per-pattern breakdown. Pure aside from `now` defaulting.
 */
export function renderBatchParseReportJson(result: BatchParseResult, options: { now?: number } = {}): string {
  const now = options.now ?? Date.now();
  return JSON.stringify(
    {
      summary: result.summary,
      entries: result.entries.map((entry) => ({
        line: entry.line,
        text: entry.text,
        ...reportToJson(entry.report, now),
      })),
    },
    null,
    2
  );
}
