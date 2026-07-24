// Rendering for `agentrelay agenda` — the relay's upcoming resume schedule,
// grouped into time windows. Where `next` surfaces the single most imminent
// resume and `status` lists the queue flat, `agenda` shows *when* each waiting
// job comes due and, crucially, which resets pile into the same window (a
// resume "herd"). Kept as pure functions (separate from the commander wiring)
// so the output is testable without a TTY or a clock.

import type { ResumeAgenda, ResumeWindow } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Shown when no job is waiting for a reset (empty queue or only active/terminal jobs). */
export const NO_AGENDA_MESSAGE = "No jobs waiting for a reset.";

function pluralJobs(n: number): string {
  return n === 1 ? "job" : "jobs";
}

/** Header line for one window, e.g. "due now — 2 jobs" or "in 5m — 3 jobs  (herd)". */
function windowHeader(win: ResumeWindow, now: number, color: boolean): string {
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const warn = (s: string): string => (color ? `${YELLOW}${s}${RESET}` : s);

  const when = win.due ? "due now" : `in ${formatCountdown(win.windowStartIso, now)}`;
  const iso = win.windowStartIso !== null ? ` ${d(`(${win.windowStartIso})`)}` : "";
  const herd = win.count > 1 ? `  ${warn("(herd)")}` : "";
  return `${b(when)}${iso} — ${win.count} ${pluralJobs(win.count)}${herd}`;
}

/**
 * Human-friendly timeline: a header per window followed by its jobs (short id,
 * project, tool), earliest first. Reuses `formatCountdown` so "due now"/"5m"/
 * "1h 3m" match the status table exactly. Pure: no ambient clock unless `now`
 * is omitted.
 */
export function renderAgenda(
  agenda: ResumeAgenda,
  options: { now?: number; color?: boolean; scopeNote?: string } = {}
): string {
  const now = options.now ?? agenda.now;
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (agenda.totalWaiting === 0) return NO_AGENDA_MESSAGE;

  const scope = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
  const dueNote = agenda.dueNow > 0 ? `, ${agenda.dueNow} due now` : "";
  const lines: string[] = [
    `${b("Resume agenda")} — ${agenda.totalWaiting} ${pluralJobs(agenda.totalWaiting)} waiting${dueNote}${scope}`,
  ];

  for (const win of agenda.windows) {
    lines.push("");
    lines.push(windowHeader(win, now, color));
    for (const entry of win.entries) {
      const id = b(entry.job.id.slice(0, 8));
      lines.push(`  ${id}  ${entry.job.project}  ${d(`(${entry.job.tool})`)}`);
    }
  }

  if (agenda.hiddenWindows > 0) {
    lines.push("");
    lines.push(
      d(
        `… ${agenda.hiddenWindows} more window(s) (${agenda.hiddenJobs} ${pluralJobs(agenda.hiddenJobs)}) not shown — raise --limit to see them.`
      )
    );
  }

  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the whole agenda
 * (totals, windows, entries) plus the store path and generation timestamp.
 */
export function renderAgendaJson(
  agenda: ResumeAgenda,
  storePath: string,
  options: { generatedAt?: string; scope?: Record<string, unknown> } = {}
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  return JSON.stringify({ storePath, generatedAt, scope: options.scope, agenda }, null, 2);
}
