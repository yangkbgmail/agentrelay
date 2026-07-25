import type { HeartbeatStatus } from "./heartbeat.js";

/**
 * A focused, script-friendly liveness probe for the resume loop.
 *
 * `agentrelay doctor` runs a full battery of setup checks (Node version, store,
 * config, notify channels, adapter binaries, …) and is meant for interactive
 * "is my install healthy?" moments. But monitoring — a systemd `ExecStartPre`,
 * a Kubernetes liveness probe, a Nagios/cron check — wants the opposite: one
 * fast question, "is the relay's resume loop working when it needs to?", boiled
 * down to a single exit code and one line of output.
 *
 * That's what this module answers. It takes the already-judged
 * {@link HeartbeatStatus} (from `evaluateHeartbeat`, the same code the dashboard
 * and `doctor` use, so all three surfaces agree) and distills it to a probe
 * verdict + exit code. It is pure: no clock, no filesystem — the CLI supplies
 * the heartbeat and waiting-job count.
 */

/**
 * The probe verdict, in the language a monitoring check cares about:
 * - `healthy` — the resume loop ticked recently; queued jobs will be picked up.
 * - `idle` — the loop isn't alive, but nothing is waiting, so there's nothing to
 *   miss. Fine by default; a failure only under {@link HealthOptions.strict}.
 * - `unhealthy` — jobs are waiting to resume but no live loop will service them.
 *   This is the failure AgentRelay exists to prevent.
 */
export type HealthLevel = "healthy" | "idle" | "unhealthy";

/** Exit code for a healthy (or idle, non-strict) probe. */
export const HEALTH_EXIT_OK = 0;
/** Exit code for an unhealthy probe (jobs stranded, or idle under `strict`). */
export const HEALTH_EXIT_UNHEALTHY = 1;

export interface HealthOptions {
  /**
   * Treat `idle` (loop not alive, but nothing waiting) as a failure too. Use
   * this when you expect the daemon to always be up regardless of queue depth,
   * e.g. a systemd/k8s liveness probe watching the daemon itself rather than
   * whether any given job resumes.
   */
  strict?: boolean;
}

export interface HealthReport {
  /** The distilled verdict — see {@link HealthLevel}. */
  level: HealthLevel;
  /** Process exit code the CLI should adopt: 0 for ok/idle, 1 for unhealthy. */
  exitCode: number;
  /**
   * A short, clock-free, grep-friendly reason. Time-formatted detail (e.g. "5m
   * ago") is left to the CLI renderer, which has the age and a humanizer.
   */
  reason: string;
  /** The underlying heartbeat judgment, echoed so `--json` consumers get it all. */
  heartbeat: HeartbeatStatus;
}

/**
 * Distill a {@link HeartbeatStatus} into a {@link HealthReport}. Pure.
 *
 * The decision leans entirely on fields `evaluateHeartbeat` already computed:
 * `state` (alive/stale/absent) and `concerning` (`!alive && waitingJobs > 0`),
 * so the probe never disagrees with `doctor` or the dashboard about liveness.
 */
export function evaluateHealth(status: HeartbeatStatus, options: HealthOptions = {}): HealthReport {
  if (status.state === "alive") {
    return {
      level: "healthy",
      exitCode: HEALTH_EXIT_OK,
      reason: "resume loop alive",
      heartbeat: status,
    };
  }

  // Not alive. The one true failure is jobs stranded with nothing to resume
  // them — exactly what `concerning` captures.
  if (status.concerning) {
    const n = status.waitingJobs;
    return {
      level: "unhealthy",
      exitCode: HEALTH_EXIT_UNHEALTHY,
      reason: `resume loop ${status.state}: ${n} job(s) waiting to resume with no live loop`,
      heartbeat: status,
    };
  }

  // Not alive, but nothing is waiting — no harm done. Fine by default; a
  // failure only when the caller demands the loop always be up.
  if (options.strict) {
    return {
      level: "unhealthy",
      exitCode: HEALTH_EXIT_UNHEALTHY,
      reason: `resume loop ${status.state} (strict: expected a live loop)`,
      heartbeat: status,
    };
  }

  return {
    level: "idle",
    exitCode: HEALTH_EXIT_OK,
    reason: `resume loop ${status.state}, nothing waiting`,
    heartbeat: status,
  };
}
