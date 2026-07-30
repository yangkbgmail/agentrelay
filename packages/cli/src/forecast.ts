// Rendering helpers for `agentrelay forecast` — a chronological "when will my
// queue drain?" view of the waiting jobs, bucketed by time-until-reset. Kept as
// pure functions here, separate from the commander wiring in cli.ts, so the
// exact output is unit-testable without a store or a clock (the only ambient
// input, `now`, is injectable for the countdowns).

import type { ResumeEvent, ResumeForecast } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Shown when the store (or scoped subset) has no jobs at all. */
export const NO_FORECAST_JOBS_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a `--status`/`--tool`/`--project` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/** Shown when there are jobs, but none are parked waiting for a reset. */
export const NO_WAITING_MESSAGE = "Nothing waiting for a reset — the relay has no scheduled resumes.";

const MAX_EVENTS_PER_BUCKET = 5;

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function eventLine(event: ResumeEvent, now: number, d: (s: string) => string): string {
  const id = shortId(event.jobId);
  const project = event.project.length > 20 ? `${event.project.slice(0, 19)}…` : event.project;
  const countdown = event.due ? "due now" : `in ${formatCountdown(event.resetAt, now)}`;
  return `    ${id}  ${project.padEnd(20)}  ${d(`${countdown} · ${event.resetAt}`)}`;
}

/**
 * Renders the resume forecast as a grouped timeline: one section per non-empty
 * time horizon (due now, within 1h, …), each listing up to a few of its
 * soonest resumes with a live countdown, then a summary footer with when the
 * queue fully drains. Pure: no I/O; the only ambient input is `now`, used for
 * the countdowns and defaulted when omitted. `color` gates ANSI codes (TTY
 * only); a `scopeNote` is echoed once at the top when a filter is active.
 */
export function renderForecast(
  forecast: ResumeForecast,
  options: { color?: boolean; scopeNote?: string; now?: number; total?: number } = {}
): string {
  const color = options.color ?? false;
  const now = options.now ?? forecast.now;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  // `total` (the job count the forecast was built from) lets us tell "no jobs
  // at all / scope matched nothing" apart from "jobs exist, none are waiting".
  const total = options.total;
  if (forecast.waiting === 0) {
    if (total === 0) {
      lines.push(options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_FORECAST_JOBS_MESSAGE);
    } else {
      lines.push(NO_WAITING_MESSAGE);
    }
    return lines.join("\n");
  }

  const overduePart = forecast.overdue > 0 ? d(` (${forecast.overdue} due now)`) : "";
  lines.push(b(`${forecast.waiting} resume(s) scheduled`) + overduePart);
  lines.push("");

  for (const bucket of forecast.buckets) {
    if (bucket.count === 0) continue;
    lines.push(`  ${b(bucket.label)} ${d(`(${bucket.count})`)}`);
    const shown = bucket.events.slice(0, MAX_EVENTS_PER_BUCKET);
    for (const event of shown) lines.push(eventLine(event, now, d));
    const hidden = bucket.count - shown.length;
    if (hidden > 0) lines.push(d(`    … ${hidden} more`));
  }

  lines.push("");
  lines.push(d(`next reset: ${forecast.nextResetAt} (in ${formatCountdown(forecast.nextResetAt, now)})`));
  if (forecast.lastResetAt !== forecast.nextResetAt) {
    lines.push(d(`queue drains: ${forecast.lastResetAt} (in ${formatCountdown(forecast.lastResetAt, now)})`));
  }

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay forecast`, mirroring the
 * `renderProjectsJson` / `renderStatsJson` envelope: the resolved store path,
 * when it was generated, the optional active scope, and the full forecast.
 * Pure: `generatedAt` is injected, never read from an ambient clock here.
 */
export function renderForecastJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  forecast: ResumeForecast;
}): string {
  return JSON.stringify(payload, null, 2);
}
