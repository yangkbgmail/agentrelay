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
  /** True when this was a preview that left the store untouched. */
  dryRun: boolean;
  /**
   * The far-future parked scan, present only when `--far-future` was requested.
   * `report.parked` lists the stranded jobs; `recovered` is what was requeued
   * (empty on a dry run).
   */
  farFuture?: { report: FarFutureParkedReport; recovered: RelayJob[] };
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

  const sections: string[] = [renderStuckSection(result, { now, b, d, m })];
  if (result.farFuture) {
    sections.push(renderFarFutureSection(result.farFuture, result.dryRun, { now, b, d, m }));
  }
  return sections.join("\n\n");
}

interface Painters {
  now: number;
  b: (s: string) => string;
  d: (s: string) => string;
  m: (s: string) => string;
}

/** The stuck-in-`resuming` section (the original, unconditional recover output). */
function renderStuckSection(result: RecoverResult, paint: Painters): string {
  const { report, dryRun } = result;
  const { now, b, d, m } = paint;

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
 * The far-future parked section (shown only under `--far-future`). Lists each
 * misparsed-reset job with how far out it was parked, or says the queue is clean
 * / the guard is disabled.
 */
function renderFarFutureSection(
  farFuture: NonNullable<RecoverResult["farFuture"]>,
  dryRun: boolean,
  paint: Painters
): string {
  const { now, b, d, m } = paint;
  const { report } = farFuture;

  const header = b("Far-future parked jobs");

  if (report.horizonMs === null) {
    return `${header}\n${d("Reset-horizon guard is disabled (AGENTRELAY_MAX_RESET_HORIZON) — nothing scanned.")}`;
  }
  if (report.parked.length === 0) {
    return `${header}\nNo jobs are parked beyond the ${formatDurationMs(report.horizonMs)} horizon. Nothing to recover.`;
  }

  const recoveredIds = new Set(farFuture.recovered.map((job) => job.id));
  const rows = dryRun ? report.parked : report.parked.filter((job) => recoveredIds.has(job.id));
  const marker = dryRun ? "-" : "↻";

  const lines: string[] = [header];
  for (const job of rows) {
    const id = job.id.slice(0, 8);
    const project = job.project.slice(0, 20).padEnd(20);
    const outBy = job.resetAt ? Math.max(0, Date.parse(job.resetAt) - now) : Number.NaN;
    const outNote = Number.isNaN(outBy) ? "reset unknown" : `reset ${formatDurationMs(outBy)} out`;
    lines.push(`${marker} ${m(id)}  ${project} ${d(outNote)}`);
  }
  const noun = rows.length === 1 ? "job" : "jobs";
  lines.push(
    dryRun
      ? `Would recover ${b(String(report.parked.length))} misparsed ${noun} (requeued to run now). ${d("No changes made.")}`
      : `Recovered ${b(String(farFuture.recovered.length))} misparsed ${noun} — requeued to resume on the next tick.`
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
      ...(result.farFuture
        ? {
            farFuture: {
              horizonMs: result.farFuture.report.horizonMs,
              waiting: result.farFuture.report.waiting,
              parked: result.farFuture.report.parked.map((job) => job.id),
              recovered: result.farFuture.recovered.map((job) => job.id),
            },
          }
        : {}),
    },
    null,
    2
  );
}
