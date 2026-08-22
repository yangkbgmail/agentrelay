// Rendering for `agentrelay watch` — a unified live "mission control" that puts
// the four things you care about while the relay runs on one screen: is the
// resume loop alive, when is the whole queue caught up, is anything overdue
// (should already have resumed but hasn't), and what's the upcoming runway of
// resumes. Where the per-subject watch views (`status`/`upcoming`/`overdue`/
// `tools`/`projects`/`stats --watch`) each answer one question, `watch` is the
// dashboard you leave open on a second monitor. It composes the existing pure
// renderers (`renderHealth`, `renderEta`, `renderUpcoming`) plus a one-line
// overdue callout, so there is zero new aggregation logic here and this surface
// can never drift from `agentrelay health`/`eta`/`overdue`/`upcoming`. Kept as
// pure functions (separate from the commander wiring in cli.ts) so the exact
// output is testable without a TTY, a clock, or a spawned process.

import type { HealthReport, OverdueReport, QueueEta, UpcomingTimeline } from "@agentrelay/core";
import { renderEta } from "./eta.js";
import { renderHealth } from "./health.js";
import { formatDurationMs } from "./stats.js";
import { renderUpcoming } from "./upcoming.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/**
 * The already-computed inputs for one dashboard frame. Passing pre-built reports
 * (rather than the raw job list) keeps this module pure and lets the CLI reuse
 * the exact same `readHealthReport`/`computeQueueEta`/`buildOverdueReport`/
 * `buildUpcomingTimeline` results the sibling commands produce.
 */
export interface DashboardData {
  /** Resume-loop liveness verdict (from `readHealthReport`). */
  health: HealthReport;
  /** Catch-up countdown for the whole queue (from `computeQueueEta`). */
  eta: QueueEta;
  /** Jobs whose reset already passed but haven't resumed (from `buildOverdueReport`). */
  overdue: OverdueReport;
  /** Forward runway of waiting jobs, soonest first (from `buildUpcomingTimeline`). */
  upcoming: UpcomingTimeline;
}

/**
 * Compose the full dashboard body: a labeled Resume-loop section, a Queue-ETA
 * section, a one-line overdue callout (only when something is overdue), and the
 * upcoming timeline table. Pure — no ambient clock unless `now` is omitted (used
 * for the countdowns), no ambient color unless `color` is passed.
 */
export function renderDashboard(
  data: DashboardData,
  options: { now?: number; color?: boolean; scopeNote?: string } = {}
): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  const label = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);

  const sections: string[] = [];

  sections.push(`${label("Resume loop")}\n  ${renderHealth(data.health, { color })}`);

  // renderEta can be one or two lines; indent every line so it reads as a block.
  const etaBody = renderEta(data.eta, { color })
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  sections.push(`${label("Queue ETA")}\n${etaBody}`);

  const callout = renderOverdueCallout(data.overdue, { color });
  if (callout) sections.push(callout);

  sections.push(
    `${label("Upcoming")}\n${indentBlock(renderUpcoming(data.upcoming, { now, color, scopeNote: options.scopeNote }))}`
  );

  return sections.join("\n\n");
}

/**
 * A single alarm line when the relay has fallen behind on resumes — the loudest
 * signal that the resume loop is down or an agent binary can't spawn. Empty
 * string when nothing is overdue (a healthy relay), so the caller can drop the
 * section entirely. Reuses `formatDurationMs` so the worst-span phrasing matches
 * `overdue`/`eta`.
 */
export function renderOverdueCallout(report: OverdueReport, options: { color?: boolean } = {}): string {
  if (report.totalOverdue === 0) return "";
  const color = options.color ?? false;
  const paint = (code: string, s: string): string => (color ? `${code}${s}${RESET}` : s);

  const jobWord = report.totalOverdue === 1 ? "job" : "jobs";
  const head = paint(
    RED,
    `${paint(BOLD, "⚠ Overdue:")} ${report.totalOverdue} ${jobWord} past due by up to ${formatDurationMs(report.maxOverdueByMs)}`
  );
  const hint = paint(DIM, "  the resume loop may be down — check `agentrelay overdue` and `agentrelay doctor`");
  return `${head}\n${hint}`;
}

/**
 * One frame of the live `agentrelay watch` view: a title/header block (matching
 * the shape of the other `--watch` frames) plus the composed dashboard. The
 * countdowns tick down in place because the loop re-reads the store and passes a
 * fresh `now` each pass.
 */
export function renderDashboardFrame(
  data: DashboardData,
  storePath: string,
  intervalMs: number,
  now: number = Date.now(),
  scopeNote?: string
): string {
  const stamp = new Date(now).toISOString().replace("T", " ").slice(0, 19);
  const title = `${BOLD}agentrelay watch${RESET} ${DIM}(live, every ${Math.round(
    intervalMs / 1000
  )}s — Ctrl-C to exit)${RESET}`;
  const meta = `${DIM}${stamp}Z · ${storePath}${RESET}`;
  return [title, meta, "", renderDashboard(data, { now, color: true, scopeNote })].join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq): the store, a generation
 * timestamp, the optional active scope, and every underlying report so a script
 * can read health, ETA, overdue, and upcoming from one call.
 */
export function renderDashboardJson(input: {
  storePath: string;
  generatedAt?: string;
  scope?: Record<string, unknown>;
  data: DashboardData;
}): string {
  const { data } = input;
  return JSON.stringify(
    {
      storePath: input.storePath,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      scope: input.scope,
      health: data.health,
      eta: data.eta,
      overdue: data.overdue,
      upcoming: data.upcoming,
    },
    null,
    2
  );
}

/** Indent every line of a rendered block by two spaces so it sits under its label. */
function indentBlock(block: string): string {
  return block
    .split("\n")
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join("\n");
}
