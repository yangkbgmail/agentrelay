// Rendering for `agentrelay eta` — a scriptable one-liner answering "when is the
// whole queue caught up?". Where `next` surfaces the single soonest resume and
// `upcoming` lists the runway, `eta` reports the countdown to the *latest* reset
// among all waiting jobs — the moment the relay has nothing left to wait on.
// Ideal for a shell prompt, a status bar, or a script deciding whether it can
// stop watching. Kept as pure functions (separate from the commander wiring) so
// the output is testable without a TTY, a clock, or a spawned process.

import type { ProjectEta, QueueEta } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

/** Shown when no job is waiting for a reset (empty queue or only active/terminal jobs). */
export const CAUGHT_UP_MESSAGE = "Queue is caught up — no jobs waiting for a reset.";

/**
 * Human-friendly single line for the catch-up ETA. Reuses `formatDurationMs`
 * so "1h 3m"/"2d 4h" match `stats`/`overdue` exactly. Pure: no ambient clock
 * unless `now` is omitted (used only to phrase already-due timelines).
 */
export function renderEta(eta: QueueEta, options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const g = (s: string): string => (color ? `${GREEN}${s}${RESET}` : s);

  if (eta.caughtUp) return g(CAUGHT_UP_MESSAGE);

  const plural = eta.waiting === 1 ? "job" : "jobs";
  // etaMs<=0 means even the last reset has passed: everything is due but the
  // resume loop hasn't caught up yet — phrase it as "due now" rather than "-".
  const when = eta.etaMs !== null && eta.etaMs > 0 ? `in ${b(formatDurationMs(eta.etaMs))}` : b("now (all due)");
  const head = `Queue caught up ${when}`;

  const facts = [`${eta.waiting} ${plural} waiting`];
  if (eta.dueNow > 0) facts.push(`${eta.dueNow} due now`);
  facts.push(`last resets at ${eta.lastResetAt}`);
  if (eta.spanMs !== null && eta.spanMs > 0) facts.push(`spread over ${formatDurationMs(eta.spanMs)}`);

  return `${head}\n${d(facts.join(", "))}.`;
}

/** Shown for `--by-project` when no project has a job waiting for a reset. */
export const NO_PROJECTS_WAITING_MESSAGE = "Queue is caught up — no project is waiting for a reset.";

/**
 * Per-project catch-up rollup for `agentrelay eta --by-project`: one line per
 * project still waiting, soonest-caught-up first (matching `computeEtaByProject`
 * ordering). Each line reuses the same duration formatting as the whole-queue
 * summary so a project's "in 1h 3m" reads identically. Pure: `now` is only used
 * to phrase already-due timelines.
 */
export function renderEtaByProject(rows: ProjectEta[], options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const g = (s: string): string => (color ? `${GREEN}${s}${RESET}` : s);

  if (rows.length === 0) return g(NO_PROJECTS_WAITING_MESSAGE);

  // Right-pad project names to a common width so the "in <duration>" column lines up.
  const nameWidth = Math.max(...rows.map((r) => r.project.length));

  const lines = rows.map((r) => {
    const { eta } = r;
    const name = r.project.padEnd(nameWidth);
    const when = eta.etaMs !== null && eta.etaMs > 0 ? `in ${b(formatDurationMs(eta.etaMs))}` : b("now (all due)");
    const plural = eta.waiting === 1 ? "job" : "jobs";
    const facts = [`${eta.waiting} ${plural}`];
    if (eta.dueNow > 0) facts.push(`${eta.dueNow} due now`);
    return `${b(name)}  caught up ${when}  ${d(`(${facts.join(", ")})`)}`;
  });

  const totalWaiting = rows.reduce((sum, r) => sum + r.eta.waiting, 0);
  const projPlural = rows.length === 1 ? "project" : "projects";
  const jobPlural = totalWaiting === 1 ? "job" : "jobs";
  const footer = d(`${rows.length} ${projPlural}, ${totalWaiting} ${jobPlural} waiting.`);

  return `${lines.join("\n")}\n${footer}`;
}

/**
 * Machine-readable form for `--json` (scripts/jq): the full `QueueEta` plus the
 * store path and generation timestamp, matching the envelope of `next --json`.
 * When `byProject` is provided (the `--by-project` view) it is included under a
 * `byProject` key; the base `eta` field stays present so both views share one shape.
 */
export function renderEtaJson(
  eta: QueueEta,
  storePath: string,
  generatedAt: string = new Date().toISOString(),
  byProject?: ProjectEta[]
): string {
  const payload: Record<string, unknown> = { storePath, generatedAt, eta };
  if (byProject !== undefined) payload.byProject = byProject;
  return JSON.stringify(payload, null, 2);
}
