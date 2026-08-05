// Rendering for `agentrelay overview` — a single-screen "control panel" glance
// at the whole relay. Where `status` dumps the table, `stats` aggregates
// metrics, `health` probes the loop, and `next`/`overdue` each answer one
// question, `overview` composes all of those into one answer to "what's the
// state of my relay right now?". Kept as pure functions here (separate from the
// commander wiring in cli.ts) so the output is unit-testable without a store or
// a clock. The verdict/next lines reuse `renderHealth`/`renderNext` so this
// surface never disagrees with the dedicated commands it summarizes.

import { ALL_STATUSES, type JobStatus, type OverviewReport } from "@agentrelay/core";
import { renderHealth } from "./health.js";
import { renderNext } from "./next.js";
import { formatDurationMs } from "./stats.js";
import { formatCountdown } from "./status.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** Shown when the store has no jobs at all. */
export const NO_JOBS_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Short labels for the per-status count line, in lifecycle order. */
const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "queued",
  waiting_for_reset: "waiting",
  resuming: "resuming",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

/**
 * The human "control panel": a header with totals, the resume-loop verdict, a
 * per-status count line, the next resume, an overdue warning (only when the
 * relay has fallen behind), and the projects with pending work. Pure — no
 * ambient clock unless `now` is omitted; `color` gates every ANSI code so piped
 * output stays plain.
 */
export function renderOverview(report: OverviewReport, options: { color?: boolean; now?: number } = {}): string {
  const color = options.color ?? false;
  const now = options.now ?? Date.now();
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);
  const r = (s: string) => (color ? `${RED}${s}${RESET}` : s);

  const lines: string[] = [];
  lines.push(`${b("AgentRelay overview")}  ${d(`${report.total} job(s) tracked`)}`);

  if (report.total === 0) {
    lines.push(NO_JOBS_MESSAGE);
    return lines.join("\n");
  }

  lines.push(d(`active ${report.activeCount}   done ${report.terminalCount}`));
  lines.push("");

  // Resume-loop verdict — reuse `health`'s renderer so the wording/colors match.
  lines.push(`${b("resume loop")}  ${renderHealth(report.health, { color })}`);

  // Per-status counts, one compact line, zero-fills every known status.
  const statusParts = ALL_STATUSES.map((s) => `${STATUS_LABEL[s]} ${report.byStatus[s]}`);
  lines.push(`${b("status")}       ${d(statusParts.join("   "))}`);
  lines.push("");

  // Next resume — reuse `next`'s renderer for identical id/project/countdown.
  lines.push(b("next resume"));
  lines.push(`  ${renderNext(report.next, { now, color })}`);

  // Overdue is a *problem* signal; only surface a line when the relay has
  // fallen behind, and color it red so it stands out.
  if (report.overdue.count > 0) {
    const worst = formatDurationMs(report.overdue.maxOverdueByMs);
    const plural = report.overdue.count === 1 ? "job" : "jobs";
    lines.push("");
    lines.push(`${r(b("overdue"))}      ${report.overdue.count} ${plural} overdue  ${d(`(worst ${worst} behind)`)}`);
    lines.push(d("  the resume loop may be down — check `agentrelay overdue` and `agentrelay health`."));
  }

  // Where the pending work sits.
  if (report.topProjects.length > 0) {
    lines.push("");
    lines.push(b("pending by project"));
    const nameWidth = Math.min(28, Math.max(7, ...report.topProjects.map((p) => p.project.length)));
    lines.push(d(`  ${"PROJECT".padEnd(nameWidth)}  ${"ACTIVE".padStart(6)}  ${"WAITING".padStart(7)}  NEXT RESET`));
    for (const p of report.topProjects) {
      const name = p.project.length > nameWidth ? `${p.project.slice(0, nameWidth - 1)}…` : p.project.padEnd(nameWidth);
      const active = String(p.active).padStart(6);
      const waiting = String(p.waiting).padStart(7);
      const reset = p.nextResetAt ? d(`in ${formatCountdown(p.nextResetAt, now)}`) : d("—");
      lines.push(`  ${name}  ${active}  ${waiting}  ${reset}`);
    }
  }

  return lines.join("\n");
}

/**
 * Machine-readable form for `--json`, mirroring the `renderNextJson` /
 * `renderHealthJson` envelope: the resolved store path, when it was generated,
 * and the full overview report. Pure — `generatedAt` is injected, never read
 * from an ambient clock here.
 */
export function renderOverviewJson(payload: {
  storePath: string;
  generatedAt: string;
  overview: OverviewReport;
}): string {
  return JSON.stringify(payload, null, 2);
}
