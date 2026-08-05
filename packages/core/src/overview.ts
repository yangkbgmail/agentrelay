import { evaluateHealth, type HealthReport } from "./health.js";
import type { HeartbeatStatus } from "./heartbeat.js";
import { type NextResume, selectNextResume } from "./next.js";
import { buildOverdueReport } from "./overdue.js";
import { type ProjectBreakdown, summarizeProjects } from "./projects.js";
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from "./stats.js";
import { type QueueSummary, summarizeJobs } from "./summary.js";
import type { RelayJob } from "./types.js";

/**
 * A single-screen snapshot of the whole relay: queue counts, resume-loop health,
 * the next resume, how far behind (overdue) it has fallen, and where the pending
 * work sits (top projects). `agentrelay overview` is the "control panel" glance —
 * where `status` dumps the table, `stats` aggregates metrics, `health` probes the
 * loop, and `next`/`overdue` each answer one question, `overview` composes all of
 * those into one answer to "what's the state of my relay right now?".
 *
 * This module is the *pure* half: it takes the job list, an already-judged
 * {@link HeartbeatStatus} (from `evaluateHeartbeat`, the same code `health`,
 * `doctor`, and the dashboard use, so every surface agrees on liveness), and an
 * injected `now` — no clock, no filesystem — and composes the existing pure
 * builders. Nothing here is re-derived; each field comes from the module that
 * already owns that computation.
 */
export interface OverviewReport {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Per-status counts, zero-filled for every known status. */
  byStatus: QueueSummary["byStatus"];
  /** Jobs still in-flight: queued + waiting_for_reset + resuming. */
  activeCount: number;
  /** Jobs in a terminal state: completed + failed + cancelled. */
  terminalCount: number;
  /** The resume-loop liveness verdict + exit code, from {@link evaluateHealth}. */
  health: HealthReport;
  /** The single job that resumes soonest, or null when nothing is waiting. */
  next: NextResume | null;
  /** How far behind the relay has fallen on resumes it should already have run. */
  overdue: {
    /** Count of `waiting_for_reset` jobs overdue by more than the grace window. */
    count: number;
    /** The worst single overdue span in ms (0 when nothing is overdue). */
    maxOverdueByMs: number;
  };
  /**
   * The projects with the most pending work, ranked (active desc, total desc,
   * name asc) and trimmed to {@link OverviewOptions.topProjects}. Only projects
   * with at least one active job appear — the overview is about what needs
   * attention, not a full project census (that's `agentrelay projects`).
   */
  topProjects: ProjectBreakdown[];
}

export interface OverviewOptions {
  /** Reference time (epoch ms) for countdowns/overdue. Defaults to `Date.now()`. */
  now?: number;
  /**
   * The already-evaluated resume-loop liveness (from `evaluateHeartbeat`). The
   * caller gathers the heartbeat (filesystem) and computes this; keeping it an
   * input leaves `buildOverview` pure and in agreement with `health`/`doctor`.
   */
  heartbeat: HeartbeatStatus;
  /**
   * Only flag jobs whose reset passed more than this many ms ago as overdue —
   * forwarded to {@link buildOverdueReport}. Defaults to 0 (any past-due waiting
   * job counts). Negative/non-finite values are treated as 0 there.
   */
  graceMs?: number;
  /**
   * Escalate the health verdict to `unhealthy` when the loop is down even with
   * nothing waiting (see {@link evaluateHealth}). Off by default.
   */
  strict?: boolean;
  /**
   * How many top projects (with pending work) to include. Defaults to 3. A value
   * <= 0 yields an empty list; non-integers are floored.
   */
  topProjects?: number;
}

/** Default number of pending-work projects surfaced in the overview. */
export const DEFAULT_OVERVIEW_TOP_PROJECTS = 3;

/**
 * Compose a {@link OverviewReport} from a job list and the current heartbeat
 * status. Pure and non-mutating — every field delegates to the module that owns
 * it (`summarizeJobs`, `selectNextResume`, `buildOverdueReport`, `evaluateHealth`,
 * `summarizeProjects`), so the overview can never drift from the dedicated
 * commands it summarizes.
 */
export function buildOverview(jobs: RelayJob[], options: OverviewOptions): OverviewReport {
  const now = options.now ?? Date.now();

  const summary = summarizeJobs(jobs);
  const activeCount = ACTIVE_STATUSES.reduce((sum, s) => sum + summary.byStatus[s], 0);
  const terminalCount = TERMINAL_STATUSES.reduce((sum, s) => sum + summary.byStatus[s], 0);

  const health = evaluateHealth(options.heartbeat, { strict: options.strict });
  const next = selectNextResume(jobs, now);
  const overdueReport = buildOverdueReport(jobs, now, { graceMs: options.graceMs });

  const topN = options.topProjects === undefined ? DEFAULT_OVERVIEW_TOP_PROJECTS : Math.floor(options.topProjects);
  const topProjects =
    topN > 0
      ? summarizeProjects(jobs)
          .projects.filter((p) => p.active > 0)
          .slice(0, topN)
      : [];

  return {
    total: summary.total,
    byStatus: summary.byStatus,
    activeCount,
    terminalCount,
    health,
    next,
    overdue: {
      count: overdueReport.totalOverdue,
      maxOverdueByMs: overdueReport.maxOverdueByMs,
    },
    topProjects,
  };
}
