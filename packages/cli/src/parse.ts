// Rendering + detection glue for `agentrelay parse` — a diagnostic that runs the
// rate-limit parser against a message so users can see, *without running a job*,
// whether AgentRelay would detect a limit, which pattern matched, and when it
// would resume. Kept as pure functions here (no stdin/clock unless injected),
// separate from the commander wiring in cli.ts, so the exact output is testable.

import type { AgentTool, RateLimitInfo, ResetPlausibility } from "@agentrelay/core";
import { classifyResetPlausibility, resolveAdapter } from "@agentrelay/core";
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

/** Reset horizons for the plausibility annotation; both `null` disables it. */
export interface PlausibilityOptions {
  /** Future horizon (ms). Beyond it, the relay's guard would drop the reset. */
  maxFutureMs?: number | null;
  /** Past horizon (ms). Before it, a fresh parse is likely a misparse. */
  maxPastMs?: number | null;
}

/**
 * Classify a report's reset against the given horizons, or `null` when there's
 * no usable reset to classify (no match, or an unparseable date). Pure aside
 * from `now` defaulting. Shared by the human and JSON renderers so both agree.
 */
export function classifyReport(
  report: ParseReport,
  options: PlausibilityOptions & { now?: number } = {}
): ResetPlausibility | null {
  if (!report.matched || !report.resetAt) return null;
  const target = new Date(report.resetAt);
  if (Number.isNaN(target.getTime())) return null;
  const now = new Date(options.now ?? Date.now());
  return classifyResetPlausibility(target, now, {
    maxFutureMs: options.maxFutureMs,
    maxPastMs: options.maxPastMs,
  });
}

/** Compact human duration ("in 3d", "in 5h", "in 2m") for a positive ms span. */
function humanizeSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Render a report as a human-readable block. Pure: no I/O, no ambient clock
 * unless `now` is omitted (used only for the reset countdown). `color` gates
 * ANSI codes (TTY only).
 */
export function renderParseReport(
  report: ParseReport,
  options: { now?: number; color?: boolean } & PlausibilityOptions = {}
): string {
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

  const plausibility = classifyReport(report, { now, maxFutureMs: options.maxFutureMs, maxPastMs: options.maxPastMs });
  if (plausibility === "too-far-future" && isActive(options.maxFutureMs)) {
    lines.push(
      paint(
        YELLOW,
        `  ⚠ beyond the reset horizon (${humanizeSpan(options.maxFutureMs)}) — AgentRelay's guard would skip this reset and let the command exit normally. Raise or disable it with AGENTRELAY_MAX_RESET_HORIZON.`,
        color
      )
    );
  } else if (plausibility === "too-far-past") {
    const behind = now - new Date(report.resetAt as string).getTime();
    lines.push(
      paint(
        YELLOW,
        `  ⚠ this reset is ${humanizeSpan(behind)} in the past — likely a misparse (wrong epoch units, a bad timezone, or a stale message), not a real reset.`,
        color
      )
    );
  }

  return lines.join("\n");
}

/** True when a horizon value is an active bound (finite and strictly positive). */
function isActive(ms: number | null | undefined): ms is number {
  return ms !== undefined && ms !== null && Number.isFinite(ms) && ms > 0;
}

/**
 * Render a report as JSON (machine-readable, for scripts/jq). Adds `resetInMs`
 * (ms until the reset time, or null when no match / unparseable) so callers
 * don't re-parse the ISO string. Pure aside from `now` defaulting.
 */
export function renderParseReportJson(
  report: ParseReport,
  options: { now?: number } & PlausibilityOptions = {}
): string {
  const now = options.now ?? Date.now();
  let resetInMs: number | null = null;
  if (report.resetAt) {
    const target = new Date(report.resetAt).getTime();
    if (!Number.isNaN(target)) resetInMs = target - now;
  }
  const plausibility = classifyReport(report, { now, maxFutureMs: options.maxFutureMs, maxPastMs: options.maxPastMs });
  return JSON.stringify({ ...report, resetInMs, plausibility }, null, 2);
}
