import type { RunResult } from "./commands.js";

/**
 * The machine-readable summary emitted by `agentrelay run --json`. It answers the
 * one question a wrapping script cares about after the wrapped command exits:
 * "did this run get rate-limited and queued, and if so what's the job id so I can
 * `agentrelay wait <id>` on it?" The shape is intentionally flat and stable so
 * `jq` filters (`.jobId`, `.queued`) stay simple.
 *
 * When the command was NOT rate-limited (`queued: false`) the job fields are all
 * null — there is no queued job — but `exitCode` still reflects the wrapped
 * command's own exit status, so a script can branch on both dimensions.
 */
export interface RunJsonSummary {
  /** True when a rate limit was detected and a resume job was enqueued. */
  queued: boolean;
  /** The wrapped command's exit code (unchanged by `--json`). */
  exitCode: number;
  /** The queued job's id (feed it to `agentrelay wait`), or null when not queued. */
  jobId: string | null;
  /** The queued job's project label, or null when not queued. */
  project: string | null;
  /** The queued job's tool adapter, or null when not queued. */
  tool: string | null;
  /** ISO timestamp the queued job will resume at, or null when not queued. */
  resetAt: string | null;
  /** The queued job's status (e.g. "waiting_for_reset"), or null when not queued. */
  status: string | null;
}

/**
 * Project a {@link RunResult} into its flat JSON summary. Pure — no I/O — so the
 * CLI can test the exact bytes it will print. When `queuedJob` is null (the
 * command finished without hitting a rate limit) every job-derived field is null.
 */
export function runResultToJsonSummary(result: RunResult): RunJsonSummary {
  const job = result.queuedJob;
  if (!job) {
    return {
      queued: false,
      exitCode: result.exitCode,
      jobId: null,
      project: null,
      tool: null,
      resetAt: null,
      status: null,
    };
  }
  return {
    queued: true,
    exitCode: result.exitCode,
    jobId: job.id,
    project: job.project,
    tool: job.tool,
    resetAt: job.resetAt ?? null,
    status: job.status,
  };
}

/**
 * Render a {@link RunResult} as a single compact JSON line (no trailing newline;
 * the caller adds one). Compact-on-one-line is deliberate: `agentrelay run
 * --json` writes it as the final line of stdout, after the wrapped command's own
 * output, so a script can grab it with `tail -n1 | jq`.
 */
export function renderRunResultJson(result: RunResult): string {
  return JSON.stringify(runResultToJsonSummary(result));
}
