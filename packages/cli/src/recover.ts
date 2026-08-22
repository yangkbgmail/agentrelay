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
const YELLOW = "\x1b[33m";

/** The outcome of a `recover` run: what was found and what was reclaimed. */
export interface RecoverResult {
  report: StuckResumingReport;
  /** Jobs actually reclaimed from `resuming` (post-transition). Empty on a dry run. */
  recovered: RelayJob[];
  /**
   * Present only when the far-future scope (`--far-future`) was requested: the
   * scan of jobs parked with an implausibly-distant reset, and which were
   * requeued (empty on a dry run).
   */
  farFuture?: {
    report: FarFutureParkedReport;
    recovered: RelayJob[];
  };
  /** True when this was a preview that left the store untouched. */
  dryRun: boolean;
}

/** How far ahead a parked job's reset is, in whole days/years, for a compact listing. */
function resetInWords(job: RelayJob, now: number): string {
  const ms = Date.parse(job.resetAt ?? "");
  if (Number.isNaN(ms)) return "unknown";
  const ahead = Math.max(0, ms - now);
  const days = ahead / 86_400_000;
  if (days >= 365) {
    const years = days / 365;
    return `${years >= 10 ? Math.round(years) : years.toFixed(1)}y`;
  }
  return `${Math.round(days)}d`;
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
  const y = (s: string): string => (color ? `${YELLOW}${s}${RESET}` : s);

  const { report, dryRun, farFuture } = result;

  const blocks: string[] = [];

  // --- Stuck-resuming block (always shown). ---
  if (report.stuck.length === 0) {
    if (report.resuming > 0) {
      const word = report.resuming === 1 ? "job is" : "jobs are";
      blocks.push(
        `No orphaned jobs to recover. ${report.resuming} ${word} resuming within the ${formatDurationMs(report.stuckAfterMs)} threshold (a live run — left alone).`
      );
    } else {
      blocks.push("No jobs are stuck resuming. Nothing to recover.");
    }
  } else {
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
    blocks.push(lines.join("\n"));
  }

  // --- Far-future parked block (only when `--far-future` was requested). ---
  if (farFuture) {
    blocks.push(renderFarFutureBlock(farFuture, dryRun, now, { b, d, m: y }));
  }

  return blocks.join("\n\n");
}

/** The far-future parked section of `renderRecover`, split out for readability. */
function renderFarFutureBlock(
  farFuture: NonNullable<RecoverResult["farFuture"]>,
  dryRun: boolean,
  now: number,
  fmt: { b: (s: string) => string; d: (s: string) => string; m: (s: string) => string }
): string {
  const { b, d, m } = fmt;
  const { report } = farFuture;

  if (report.horizonMs === null) {
    return d("Far-future scan skipped: the reset-horizon guard is disabled (AGENTRELAY_MAX_RESET_HORIZON=off).");
  }
  if (report.farFuture.length === 0) {
    const scanned = report.parked === 1 ? "1 parked job" : `${report.parked} parked jobs`;
    return `No far-future parked jobs to recover. ${scanned} within the ${formatDurationMs(report.horizonMs)} horizon.`;
  }

  const recoveredIds = new Set(farFuture.recovered.map((job) => job.id));
  const rows = dryRun ? report.farFuture : report.farFuture.filter((job) => recoveredIds.has(job.id));
  const marker = dryRun ? "-" : "↻";

  const lines: string[] = [];
  for (const job of rows) {
    const id = job.id.slice(0, 8);
    const project = job.project.slice(0, 20).padEnd(20);
    lines.push(`${marker} ${m(id)}  ${project} ${d(`resets in ${resetInWords(job, now)}`)}`);
  }
  const noun = rows.length === 1 ? "job" : "jobs";
  lines.push(
    dryRun
      ? `Would recover ${b(String(report.farFuture.length))} far-future parked ${noun} (requeued to run now). ${d("No changes made.")}`
      : `Recovered ${b(String(farFuture.recovered.length))} far-future parked ${noun} — requeued to resume on the next tick.`
  );
  return lines.join("\n");
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
  if (result.farFuture) {
    payload.farFuture = {
      horizonMs: result.farFuture.report.horizonMs,
      parked: result.farFuture.report.parked,
      stuck: result.farFuture.report.farFuture.map((job) => job.id),
      recovered: result.farFuture.recovered.map((job) => job.id),
    };
  }
  return JSON.stringify(payload, null, 2);
}
