// Rendering + detection glue for `agentrelay parse` — a diagnostic that runs the
// rate-limit parser against a message so users can see, *without running a job*,
// whether AgentRelay would detect a limit, which pattern matched, and when it
// would resume. Kept as pure functions here (no stdin/clock unless injected),
// separate from the commander wiring in cli.ts, so the exact output is testable.

import type { AgentTool, PatternProbe, RateLimitInfo } from "@agentrelay/core";
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
 * The `--all` view of a parse: the same winning-detection fields as
 * {@link ParseReport}, plus every pattern's individual outcome (in the parser's
 * priority order) and whether the generic pre-filter passed. Lets pattern
 * authors and users see exactly which patterns fire, which merely match but
 * lose priority, and which match yet are blocked by the pre-filter.
 */
export interface ParseExplanation {
  tool: AgentTool;
  matched: boolean;
  resetAt: string | null;
  rawMatch: string | null;
  pattern: string | null;
  prefilterPassed: boolean;
  patterns: PatternProbe[];
}

/**
 * Run the diagnostic explainer against `text` for the given tool's adapter.
 * Pure aside from `options.now` (defaults inside the core explainer).
 */
export function buildParseExplanation(text: string, options: { tool?: AgentTool; now?: Date } = {}): ParseExplanation {
  const adapter = resolveAdapter({ tool: options.tool });
  const explanation = explainRateLimitMessage(text, {
    extraPatterns: adapter.patterns,
    ...(options.now ? { now: options.now } : {}),
  });
  const { detected } = explanation;
  return {
    tool: adapter.tool,
    matched: detected !== null,
    resetAt: detected?.resetAt ?? null,
    rawMatch: detected?.rawMatch ?? null,
    pattern: detected?.pattern ?? null,
    prefilterPassed: explanation.prefilterPassed,
    patterns: explanation.patterns,
  };
}

/**
 * Render the `--all` explanation as a human-readable table: one row per
 * pattern in priority order, with a marker for the winner (★), plain matches
 * that lost priority (✓), pre-filter-blocked matches (⚠), and misses (·). Pure:
 * no I/O; `now` is only used for the winner's reset countdown, `color` gates
 * ANSI codes (TTY only).
 */
export function renderParseExplanation(
  report: ParseExplanation,
  options: { now?: number; color?: boolean } = {}
): string {
  const color = options.color ?? false;
  const now = options.now ?? Date.now();

  const nameWidth = report.patterns.reduce((max, p) => Math.max(max, p.name.length), 0);
  const lines: string[] = [`Pattern report ${paint(DIM, `(adapter: ${report.tool})`, color)}`, ""];

  for (const probe of report.patterns) {
    const isWinner = report.matched && probe.name === report.pattern && probe.rawMatch === report.rawMatch;
    let marker: string;
    let detail: string;
    if (isWinner) {
      const countdown = formatCountdown(probe.resetAt, now);
      marker = paint(GREEN, "★", color);
      detail = `${JSON.stringify(probe.rawMatch)} ${paint(DIM, `→ ${probe.resetAt} (in ${countdown})`, color)}`;
    } else if (probe.blockedByPrefilter) {
      marker = paint(YELLOW, "⚠", color);
      detail = `${JSON.stringify(probe.rawMatch)} ${paint(YELLOW, "(matched but blocked by pre-filter)", color)}`;
    } else if (probe.matched) {
      marker = paint(DIM, "✓", color);
      detail = `${JSON.stringify(probe.rawMatch)} ${paint(DIM, "(matched but a higher-priority pattern won)", color)}`;
    } else {
      marker = paint(DIM, "·", color);
      detail = paint(DIM, "—", color);
    }
    const label = paint(DIM, `[${probe.source}]`, color);
    lines.push(`  ${marker} ${probe.name.padEnd(nameWidth)}  ${label}  ${detail}`);
  }

  lines.push("");
  if (report.matched) {
    const countdown = formatCountdown(report.resetAt, now);
    lines.push(
      `${paint(GREEN, "Result:", color)} rate limit detected via ${paint(BOLD, report.pattern ?? "", color)} — resumes in ${countdown}.`
    );
  } else {
    const blocked = report.patterns.some((p) => p.blockedByPrefilter);
    lines.push(`${paint(YELLOW, "Result:", color)} no rate-limit detected.`);
    if (blocked) {
      lines.push(
        paint(
          DIM,
          "  A pattern matched but the message tripped no pre-filter keyword, so AgentRelay ignores it.",
          color
        )
      );
    }
  }
  return lines.join("\n");
}

/**
 * Render the `--all` explanation as JSON (machine-readable). Adds `resetInMs`
 * to the winning detection (as {@link renderParseReportJson} does). Pure aside
 * from `now` defaulting.
 */
export function renderParseExplanationJson(report: ParseExplanation, options: { now?: number } = {}): string {
  const now = options.now ?? Date.now();
  let resetInMs: number | null = null;
  if (report.resetAt) {
    const target = new Date(report.resetAt).getTime();
    if (!Number.isNaN(target)) resetInMs = target - now;
  }
  return JSON.stringify({ ...report, resetInMs }, null, 2);
}
