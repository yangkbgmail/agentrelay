// Rendering for `agentrelay recover` — reclaiming jobs orphaned mid-resume.
//
// When a resume loop (daemon/tick) dies between marking a job `resuming` and
// recording its outcome, the job is stranded in `resuming`: no tick re-runs it
// and `retry` refuses it. This command finds those stuck jobs and requeues them
// to run again. Kept as pure functions (separate from the commander wiring in
// cli.ts) so the exact output is unit-testable without a TTY, a clock, or the
// store.

import type { FarFutureResetJob, RelayJob, StuckResumingReport } from "@agentrelay/core";
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
  /** True when this was a preview that left the store untouched. */
  dryRun: boolean;
}

/** How long a job has been stuck in `resuming`, from its `updatedAt` to `now`. */
function stuckFor(job: RelayJob, now: number): string {
  const ms = Date.parse(job.updatedAt);
  if (Number.isNaN(ms)) return "unknown";
  return formatDurationMs(Math.max(0, now - ms));
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

  const { report, dryRun } = result;

  if (report.stuck.length === 0) {
    if (report.resuming > 0) {
      const word = report.resuming === 1 ? "job is" : "jobs are";
      return `No orphaned jobs to recover. ${report.resuming} ${word} resuming within the ${formatDurationMs(report.stuckAfterMs)} threshold (a live run — left alone).`;
    }
    return "No jobs are stuck resuming. Nothing to recover.";
  }

  // Rows come from `report.stuck` (jobs as observed *before* recovery), so the
  // "stuck for" age reflects how long each really waited — `result.recovered`
  // carries the post-transition `updatedAt` (now), which would read as <1s. On a
  // real run, only rows whose job was actually reclaimed are shown (a job that
  // finished resuming between scan and write is skipped).
  const recoveredIds = new Set(result.recovered.map((job) => job.id));
  const rows = dryRun ? report.stuck : report.stuck.filter((job) => recoveredIds.has(job.id));
  const marker = dryRun ? "-" : "↻";

  const lines: string[] = [];
  for (const job of rows) {
    const id = job.id.slice(0, 8);
    const project = job.project.slice(0, 20).padEnd(20);
    lines.push(`${marker} ${m(id)}  ${project} ${d(`stuck ${stuckFor(job, now)}`)}`);
  }
  const noun = rows.length === 1 ? "job" : "jobs";
  lines.push(
    dryRun
      ? `Would recover ${b(String(report.stuck.length))} ${noun} (requeued to run now). ${d("No changes made.")}`
      : `Recovered ${b(String(result.recovered.length))} ${noun} — requeued to resume on the next tick.`
  );
  return lines.join("\n");
}

/**
 * The outcome of a `recover --far-future` run: the jobs found parked with an
 * implausibly-distant reset (a misparse the horizon guard would reject today)
 * and which of them were requeued to run now.
 *
 * This is the second silent-failure class `recover` reclaims. Where the default
 * mode rescues jobs a *crashed loop* stranded in `resuming`, this one rescues
 * jobs a *bad reset time* stranded in `waiting_for_reset` — parked so far ahead
 * they'd never resume in a sane window. `doctor`/the dashboard already surface
 * them (shared `selectFarFutureResets`); this makes them actionable in bulk
 * without hand-copying each id into `retry`.
 */
export interface RecoverFarFutureResult {
  /**
   * The horizon (ms) judged against, or `null` when the guard is disabled
   * (`AGENTRELAY_MAX_RESET_HORIZON=off`) — then nothing is flagged.
   */
  horizonMs: number | null;
  /** Total jobs considered. */
  total: number;
  /** Active jobs parked beyond the horizon, as observed before recovery. */
  parked: FarFutureResetJob[];
  /** Jobs actually requeued (post-transition). Empty on a dry run. */
  recovered: RelayJob[];
  /** True when this was a preview that left the store untouched. */
  dryRun: boolean;
}

/**
 * Human-readable summary for `recover --far-future`. Says so plainly when the
 * guard is disabled or nothing is parked; otherwise lists each parked job
 * (soonest-past-horizon first — the least-extreme, likeliest a real edge case)
 * with how far ahead its reset sits, and reports how many were requeued. On a
 * real run only the jobs actually requeued are listed; a job that isn't
 * requeue-eligible (e.g. it slipped into `resuming`) is flagged but skipped.
 */
export function renderRecoverFarFuture(
  result: RecoverFarFutureResult,
  options: { now?: number; color?: boolean } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const m = (s: string): string => (color ? `${MAGENTA}${s}${RESET}` : s);

  const { parked, dryRun, horizonMs } = result;

  if (horizonMs === null) {
    return "The reset-horizon guard is disabled (AGENTRELAY_MAX_RESET_HORIZON=off); no far-future resets are bounded, so there is nothing to recover.";
  }
  if (parked.length === 0) {
    return `No jobs are parked with a reset beyond the ${formatDurationMs(horizonMs)} horizon. Nothing to recover.`;
  }

  // Soonest-past-horizon first: mirrors `doctor`/dashboard ordering so the same
  // job leads every surface.
  const sorted = [...parked].sort((a, b2) => a.msUntilReset - b2.msUntilReset);
  const recoveredIds = new Set(result.recovered.map((job) => job.id));
  const rows = dryRun ? sorted : sorted.filter((job) => recoveredIds.has(job.id));
  const marker = dryRun ? "-" : "↻";

  const lines: string[] = [];
  for (const job of rows) {
    const id = job.id.slice(0, 8);
    const project = job.project.slice(0, 20).padEnd(20);
    lines.push(`${marker} ${m(id)}  ${project} ${d(`resets in ${formatDurationMs(job.msUntilReset)}`)}`);
  }
  const noun = rows.length === 1 ? "job" : "jobs";
  lines.push(
    dryRun
      ? `Would recover ${b(String(parked.length))} ${noun} (requeued to run now). ${d("No changes made.")}`
      : `Recovered ${b(String(result.recovered.length))} ${noun} — requeued to resume on the next tick.`
  );
  return lines.join("\n");
}

/**
 * Machine-readable form of a `recover --far-future` run for `--json`.
 */
export function renderRecoverFarFutureJson(
  result: RecoverFarFutureResult,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify(
    {
      storePath,
      generatedAt,
      mode: "far-future",
      dryRun: result.dryRun,
      horizonMs: result.horizonMs,
      total: result.total,
      parked: result.parked.map((job) => job.id),
      recovered: result.recovered.map((job) => job.id),
    },
    null,
    2
  );
}

/**
 * Machine-readable form for `--json` (scripts/jq): the full stuck-resuming
 * report plus which jobs were reclaimed and whether it was a dry run.
 */
export function renderRecoverJson(
  result: RecoverResult,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify(
    {
      storePath,
      generatedAt,
      dryRun: result.dryRun,
      stuckAfterMs: result.report.stuckAfterMs,
      resuming: result.report.resuming,
      total: result.report.total,
      stuck: result.report.stuck.map((job) => job.id),
      recovered: result.recovered.map((job) => job.id),
    },
    null,
    2
  );
}
