// Rendering helpers for `agentrelay projects` — a per-project index of the
// queue built from `job.project`, the label the whole `--project` filter
// ecosystem keys off. Kept as pure functions here, separate from the commander
// wiring in cli.ts, so the exact output is unit-testable without a store or a
// clock (the only ambient input, `now`, is injectable for the reset countdown).

import type { ProjectsSummary } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Shown when the store (or scoped subset) has no jobs at all. */
export const NO_PROJECTS_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a `--status`/`--tool`/`--project` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/**
 * Renders the project index as a table: one row per project with its total,
 * active, and terminal counts plus, when jobs are parked, the soonest reset
 * (with a live countdown). Pure: no I/O; the only ambient input is `now`, used
 * solely for the countdown and defaulted when omitted. `color` gates ANSI codes
 * (TTY only); a `scopeNote` is echoed once at the top when a filter is active.
 */
export function renderProjects(
  summary: ProjectsSummary,
  options: { color?: boolean; scopeNote?: string; now?: number } = {}
): string {
  const color = options.color ?? false;
  const now = options.now ?? Date.now();
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  if (summary.total === 0) {
    lines.push(options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_PROJECTS_MESSAGE);
    return lines.join("\n");
  }

  lines.push(b(`${summary.projectCount} project(s)`) + d(` across ${summary.total} job(s)`));
  lines.push("");

  const nameWidth = Math.min(28, Math.max(7, ...summary.projects.map((p) => p.project.length)));
  lines.push(
    d(
      `  ${"PROJECT".padEnd(nameWidth)}  ${"TOTAL".padStart(5)}  ${"ACTIVE".padStart(6)}  ${"DONE".padStart(4)}  NEXT RESET`
    )
  );

  for (const p of summary.projects) {
    const name = p.project.length > nameWidth ? `${p.project.slice(0, nameWidth - 1)}…` : p.project.padEnd(nameWidth);
    const total = String(p.total).padStart(5);
    const active = String(p.active).padStart(6);
    const done = String(p.terminal).padStart(4);
    let reset: string;
    if (p.nextResetAt) {
      reset = `${p.nextResetAt} ${d(`(in ${formatCountdown(p.nextResetAt, now)})`)}`;
    } else if (p.active > 0) {
      reset = d("—");
    } else {
      reset = d("(idle)");
    }
    lines.push(`  ${name}  ${total}  ${active}  ${done}  ${reset}`);
  }

  return lines.join("\n");
}

/**
 * One frame of the live `projects --watch` view: a title/header block (matching
 * the shape of `upcoming --watch`) plus the colored table. Separated out so the
 * watch loop only has to clear the screen and print this. The reset countdowns
 * tick down in place because the loop re-reads the store and passes a fresh `now`
 * each pass.
 */
export function renderProjectsWatchFrame(
  summary: ProjectsSummary,
  storePath: string,
  intervalMs: number,
  now: number = Date.now(),
  scopeNote?: string
): string {
  const stamp = new Date(now).toISOString().replace("T", " ").slice(0, 19);
  const title = `${BOLD}agentrelay projects${RESET} ${DIM}(live, every ${Math.round(
    intervalMs / 1000
  )}s — Ctrl-C to exit)${RESET}`;
  const meta = `${DIM}${stamp}Z · ${storePath}${RESET}`;
  return [title, meta, "", renderProjects(summary, { color: true, scopeNote, now })].join("\n");
}

/**
 * Machine-readable form of `agentrelay projects`, mirroring the `renderStatsJson`
 * / `renderPatternsJson` envelope: the resolved store path, when it was
 * generated, the optional active scope, and the full summary. Pure:
 * `generatedAt` is injected, never read from an ambient clock here.
 */
export function renderProjectsJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  summary: ProjectsSummary;
}): string {
  return JSON.stringify(payload, null, 2);
}
