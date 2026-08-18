// Rendering + detection glue for `agentrelay parse` — a diagnostic that runs the
// rate-limit parser against a message so users can see, *without running a job*,
// whether AgentRelay would detect a limit, which pattern matched, and when it
// would resume. Kept as pure functions here (no stdin/clock unless injected),
// separate from the commander wiring in cli.ts, so the exact output is testable.

import type { AgentTool, ExplainReport, PatternTrace, RateLimitInfo } from "@agentrelay/core";
import { explainRateLimitMessage, resolveAdapter } from "@agentrelay/core";
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

const RED = "\x1b[31m";

/**
 * Run the diagnostic parser (every pattern, not just the first hit) against
 * `text` with the given tool's adapter patterns tried first. Pure: `now` is the
 * only ambient input, defaulted inside core when omitted. Powers `parse --explain`.
 */
export function buildExplainReport(
  text: string,
  options: { tool?: AgentTool; now?: Date } = {}
): { tool: AgentTool; report: ExplainReport } {
  const adapter = resolveAdapter({ tool: options.tool });
  const report = explainRateLimitMessage(text, {
    extraPatterns: adapter.patterns,
    ...(options.now ? { now: options.now } : {}),
  });
  return { tool: adapter.tool, report };
}

/** Human label + color for why a matched pattern wasn't the one selected. */
function skipLabel(skip: PatternTrace["skipped"]): { text: string; color: string } {
  switch (skip) {
    case "unresolved":
      return { text: "matched, but no valid reset time", color: YELLOW };
    case "implausible":
      return { text: "reset too far out — rejected by horizon guard", color: YELLOW };
    case "prefiltered":
      return { text: "regex matched, but text isn't rate-limit-y (skipped)", color: DIM };
    case "superseded":
      return { text: "usable, but an earlier pattern already won", color: DIM };
    default:
      return { text: "", color: DIM };
  }
}

/**
 * Render a full per-pattern breakdown for `parse --explain`. Every pattern tried
 * is listed with a status glyph so a user can see exactly why a message matched
 * — or why it didn't. Pure: no I/O; `now` only feeds the reset countdown.
 */
export function renderExplainReport(
  data: { tool: AgentTool; report: ExplainReport },
  options: { now?: number; color?: boolean } = {}
): string {
  const color = options.color ?? false;
  const now = options.now ?? Date.now();
  const { tool, report } = data;

  const header = report.matched
    ? `${paint(GREEN, "Rate limit detected", color)} ${paint(DIM, `(adapter: ${tool}, pattern: ${report.selectedPattern})`, color)}`
    : `${paint(YELLOW, "No rate-limit detected", color)} ${paint(DIM, `(adapter: ${tool})`, color)}`;

  const prefilter = report.looksLikeRateLimit
    ? paint(DIM, "pre-filter: looks rate-limit-y — generic patterns were tried", color)
    : paint(DIM, "pre-filter: not rate-limit-y — only adapter patterns were tried", color);

  const lines = [header, prefilter, ""];
  for (const trace of report.traces) {
    const src = paint(DIM, `[${trace.source}]`, color);
    if (trace.selected) {
      const countdown = trace.resetAt ? ` ${paint(DIM, `(in ${formatCountdown(trace.resetAt, now)})`, color)}` : "";
      lines.push(
        `  ${paint(GREEN, "✓", color)} ${paint(BOLD, trace.name, color)} ${src} → ${trace.resetAt}${countdown}`
      );
      lines.push(`      ${paint(DIM, `matched ${JSON.stringify(trace.rawMatch)}`, color)}`);
    } else if (!trace.regexMatched) {
      lines.push(
        `  ${paint(DIM, "·", color)} ${paint(DIM, trace.name, color)} ${src} ${paint(DIM, "no match", color)}`
      );
    } else {
      const label = skipLabel(trace.skipped);
      const glyph = trace.skipped === "implausible" || trace.skipped === "unresolved" ? RED : DIM;
      lines.push(
        `  ${paint(glyph, "✗", color)} ${paint(BOLD, trace.name, color)} ${src} ${paint(label.color, label.text, color)}`
      );
      lines.push(`      ${paint(DIM, `matched ${JSON.stringify(trace.rawMatch)}`, color)}`);
    }
  }
  return lines.join("\n");
}

/** Render the explain report as JSON (machine-readable). Pure aside from `now`. */
export function renderExplainReportJson(
  data: { tool: AgentTool; report: ExplainReport },
  options: { now?: number } = {}
): string {
  const now = options.now ?? Date.now();
  const traces = data.report.traces.map((t) => {
    let resetInMs: number | null = null;
    if (t.resetAt) {
      const target = new Date(t.resetAt).getTime();
      if (!Number.isNaN(target)) resetInMs = target - now;
    }
    return { ...t, resetInMs };
  });
  return JSON.stringify({ tool: data.tool, ...data.report, traces }, null, 2);
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
