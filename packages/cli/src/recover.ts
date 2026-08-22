// Rendering for `agentrelay recover` — reclaiming jobs orphaned mid-resume.
//
// When a resume loop (daemon/tick) dies between marking a job `resuming` and
// recording its outcome, the job is stranded in `resuming`: no tick re-runs it
// and `retry` refuses it. This command finds those stuck jobs and requeues them
// to run again. Kept as pure functions (separate from the commander wiring in
// cli.ts) so the exact output is unit-testable without a TTY, a clock, or the
// store.

import type { FarFutureParkedReport, RelayJob, StuckResumingReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const MAGENTA = "\x1b[35m";

/** The outcome of a `recover` run: what was found and what was reclaimed. */
export interface RecoverResult {
  report: StuckResumingReport;
  /** Jobs actually reclaimed (post-transition). Empty on a dry run. */
  recovered: RelayJob[];
  /**
   * The far-future parked report — present only when `--far-future` was
   * requested. Lets the renderer distinguish "not asked for" from "asked, none
   * found".
   */
  farFutureReport?: FarFutureParkedReport;
  /** Far-future parked jobs actually reclaimed (post-transition). Empty on a dry run. */
  farFutureRecovered?: RelayJob[];
  /** True when this was a preview that left the store untouched. */
  dryRun: boolean;
}

/** How long a job has been stuck in `resuming`, from its `updatedAt` to `now`. */
function stuckFor(job: RelayJob, now: number): string {
  const ms = Date.parse(job.updatedAt);
  if (Number.isNaN(ms)) return "unknown";
  return formatDurationMs(Math.max(0, now - ms));
}

/** How far in the future a parked job's reset sits, from `now` to its `resetAt`. */
function resetIn(job: RelayJob, now: number): string {
  if (!job.resetAt) return "unknown";
  const ms = Date.parse(job.resetAt);
  if (Number.isNaN(ms)) return "unknown";
  return formatDurationMs(Math.max(0, ms - now));
}

/**
 * Human-readable summary. When nothing is stuck, says so (and notes how many
 * jobs are legitimately resuming right now, if any, so a live run isn't mistaken
 * for a problem). Otherwise lists each reclaimed (or would-be-reclaimed) job
 * with how long it sat stuck. Pure: `now` defaults to the wall clock only when
 * omitted.
 */
export function renderRecover(result: RecoverResult, options: { now?: number; color?: boolean } = {}): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const m = (s: string): string => (color ? `${MAGENTA}${s}${RESET}` : s);

  const { report, farFutureReport, dryRun } = result;
  const marker = dryRun ? "-" : "↻";
  const noun = (n: number): string => (n === 1 ? "job" : "jobs");
  const sections: string[] = [];

  // Section 1 — orphaned resumes (always evaluated).
  if (report.stuck.length > 0) {
    // Rows come from `report.stuck` (jobs as observed *before* recovery), so the
    // "stuck for" age reflects how long each really waited — `result.recovered`
    // carries the post-transition `updatedAt` (now), which would read as <1s. On
    // a real run, only rows whose job was actually reclaimed are shown (a job
    // that finished resuming between scan and write is skipped).
    const recoveredIds = new Set(result.recovered.map((job) => job.id));
    const rows = dryRun ? report.stuck : report.stuck.filter((job) => recoveredIds.has(job.id));
    const lines: string[] = [];
    for (const job of rows) {
      const id = job.id.slice(0, 8);
      const project = job.project.slice(0, 20).padEnd(20);
      lines.push(`${marker} ${m(id)}  ${project} ${d(`stuck ${stuckFor(job, now)}`)}`);
    }
    lines.push(
      dryRun
        ? `Would recover ${b(String(report.stuck.length))} orphaned ${noun(report.stuck.length)} (requeued to run now). ${d("No changes made.")}`
        : `Recovered ${b(String(result.recovered.length))} orphaned ${noun(result.recovered.length)} — requeued to resume on the next tick.`
    );
    sections.push(lines.join("\n"));
  }

  // Section 2 — far-future parked jobs (only when `--far-future` was requested).
  if (farFutureReport && farFutureReport.farFuture.length > 0) {
    const recoveredIds = new Set((result.farFutureRecovered ?? []).map((job) => job.id));
    const rows = dryRun
      ? farFutureReport.farFuture
      : farFutureReport.farFuture.filter((job) => recoveredIds.has(job.id));
    const count = dryRun ? farFutureReport.farFuture.length : (result.farFutureRecovered ?? []).length;
    const lines: string[] = [];
    for (const job of rows) {
      const id = job.id.slice(0, 8);
      const project = job.project.slice(0, 20).padEnd(20);
      lines.push(`${marker} ${m(id)}  ${project} ${d(`reset in ${resetIn(job, now)}`)}`);
    }
    lines.push(
      dryRun
        ? `Would recover ${b(String(farFutureReport.farFuture.length))} far-future ${noun(farFutureReport.farFuture.length)} (requeued to run now). ${d("No changes made.")}`
        : `Recovered ${b(String(count))} far-future ${noun(count)} — requeued to resume on the next tick.`
    );
    sections.push(lines.join("\n"));
  }

  if (sections.length > 0) return sections.join("\n\n");

  // Nothing reclaimable in either class — explain what was seen.
  const notes: string[] = [];
  if (report.resuming > 0) {
    const word = report.resuming === 1 ? "job is" : "jobs are";
    notes.push(
      `${report.resuming} ${word} resuming within the ${formatDurationMs(report.stuckAfterMs)} threshold (a live run — left alone).`
    );
  }
  if (farFutureReport && farFutureReport.horizonMs === null) {
    notes.push("Far-future guard is disabled (AGENTRELAY_MAX_RESET_HORIZON=off) — no parked jobs checked.");
  }
  if (notes.length > 0) return `No orphaned jobs to recover. ${notes.join(" ")}`;
  return "No jobs are stuck resuming. Nothing to recover.";
}

/**
 * Machine-readable form for `--json` (scripts/jq): the full stuck-resuming
 * report plus which jobs were reclaimed and whether it was a dry run. The
 * `farFuture` block is emitted only when `--far-future` was requested, so the
 * base shape is unchanged for callers that don't use it.
 */
export function renderRecoverJson(
  result: RecoverResult,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  const payload: Record<string, unknown> = {
    storePath,
    generatedAt,
    dryRun: result.dryRun,
    stuckAfterMs: result.report.stuckAfterMs,
    resuming: result.report.resuming,
    total: result.report.total,
    stuck: result.report.stuck.map((job) => job.id),
    recovered: result.recovered.map((job) => job.id),
  };
  if (result.farFutureReport) {
    payload.farFuture = {
      horizonMs: result.farFutureReport.horizonMs,
      parked: result.farFutureReport.parked,
      stuck: result.farFutureReport.farFuture.map((job) => job.id),
      recovered: (result.farFutureRecovered ?? []).map((job) => job.id),
    };
  }
  return JSON.stringify(payload, null, 2);
}
