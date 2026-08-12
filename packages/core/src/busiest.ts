import { ACTIVE_STATUSES } from "./stats.js";
import type { JobStatus, RelayJob } from "./types.js";

/**
 * Per-command rollup for `agentrelay busiest`.
 *
 * `projects`/`tools` already group the queue by *label* (`job.project`) and by
 * *agent tool* (`job.tool`), but neither answers the question a maintainer
 * actually asks after a long unattended run: *which exact command is the relay
 * spending the most effort on?* The whole point of AgentRelay is re-running the
 * same command across successive rate-limit windows, so the natural unit of
 * "cost" is the command string itself, and the natural measure of cost is the
 * total number of resume attempts it has accrued.
 *
 * This groups jobs by their exact `command` (argv), summing `job.attempts` into
 * a `relay effort` figure so the command that keeps hitting limits — and keeps
 * getting babysat — floats to the top. Kept pure and non-mutating like
 * `summarizeProjects`/`summarizeJobs`: no I/O, no ambient clock.
 */
export interface CommandBreakdown {
  /** The exact command argv this row groups (e.g. `["claude", "-p", "go"]`). */
  command: string[];
  /** A single-line, shell-ish rendering of `command` for display/JSON keys. */
  display: string;
  /** Total jobs carrying this exact command (within any scope the caller applied). */
  total: number;
  /** Jobs still in-flight: queued + waiting_for_reset + resuming. */
  active: number;
  /** Jobs in a terminal state: completed + failed + cancelled. */
  terminal: number;
  /** Jobs specifically parked waiting for a rate-limit reset. */
  waiting: number;
  /**
   * Total resume attempts summed across this command's jobs — the "relay
   * effort" this command has cost. Rows are ranked by this first.
   */
  attempts: number;
  /**
   * Earliest `resetAt` (ISO) among this command's `waiting_for_reset` jobs, or
   * null when none wait. Lets you spot which command resumes soonest.
   */
  nextResetAt: string | null;
  /**
   * The most recent `updatedAt` (ISO) across this command's jobs, or null when
   * no job has a usable timestamp — a rough "last touched" marker.
   */
  lastActivityAt: string | null;
}

/**
 * Fleet-wide command index: total jobs considered, the number of distinct
 * commands, the total relay effort (attempts) across all of them, and the
 * per-command breakdown ranked so the costliest command floats to the top.
 */
export interface BusiestSummary {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Number of distinct command argvs. */
  commandCount: number;
  /** Total resume attempts across all considered jobs. */
  totalAttempts: number;
  /** Per-command rows, ranked costliest-first (see {@link summarizeBusiest}). */
  commands: CommandBreakdown[];
}

const ACTIVE_SET = new Set<JobStatus>(ACTIVE_STATUSES);

/**
 * Render an argv as a single, mostly shell-safe line: tokens that contain
 * whitespace, quotes, or are empty are wrapped in double quotes (with embedded
 * double quotes escaped) so the boundaries stay unambiguous. This is for
 * *display and grouping keys only* — it is not meant to round-trip through a
 * shell. An empty argv renders as `""` so it is still a visible, distinct key.
 */
export function formatCommand(command: string[]): string {
  if (command.length === 0) return '""';
  return command
    .map((token) => {
      if (token === "" || /[\s"'\\]/.test(token)) {
        return `"${token.replace(/(["\\])/g, "\\$1")}"`;
      }
      return token;
    })
    .join(" ");
}

/**
 * Groups a job list by exact `job.command` into a per-command breakdown for
 * `agentrelay busiest`. Pure and non-mutating: no I/O, no ambient clock. ISO
 * timestamps are compared lexically (they sort chronologically), matching how
 * `summarizeProjects` picks the earliest `resetAt` / latest `updatedAt`; a
 * missing/empty `resetAt` or `updatedAt` simply doesn't participate.
 *
 * Jobs are grouped by the JSON encoding of their argv, so `["claude","-p"]` and
 * `["claude","-P"]` stay distinct while identical commands (even across
 * projects/cwds) collapse into one row.
 *
 * Rows are ranked by `attempts` (desc) — the costliest command first — then by
 * `total` (desc), then `active` (desc), then `display` (asc) for a stable,
 * deterministic order.
 */
export function summarizeBusiest(jobs: RelayJob[]): BusiestSummary {
  const buckets = new Map<string, CommandBreakdown>();
  let totalAttempts = 0;

  for (const job of jobs) {
    const command = job.command ?? [];
    const key = JSON.stringify(command);
    let row = buckets.get(key);
    if (!row) {
      row = {
        command,
        display: formatCommand(command),
        total: 0,
        active: 0,
        terminal: 0,
        waiting: 0,
        attempts: 0,
        nextResetAt: null,
        lastActivityAt: null,
      };
      buckets.set(key, row);
    }

    row.total += 1;
    const attempts = Number.isFinite(job.attempts) && job.attempts > 0 ? job.attempts : 0;
    row.attempts += attempts;
    totalAttempts += attempts;

    if (ACTIVE_SET.has(job.status)) row.active += 1;
    else row.terminal += 1;

    if (job.status === "waiting_for_reset") {
      row.waiting += 1;
      if (job.resetAt && (row.nextResetAt === null || job.resetAt < row.nextResetAt)) {
        row.nextResetAt = job.resetAt;
      }
    }

    if (job.updatedAt && (row.lastActivityAt === null || job.updatedAt > row.lastActivityAt)) {
      row.lastActivityAt = job.updatedAt;
    }
  }

  const commands = [...buckets.values()].sort((a, b) => {
    if (b.attempts !== a.attempts) return b.attempts - a.attempts;
    if (b.total !== a.total) return b.total - a.total;
    if (b.active !== a.active) return b.active - a.active;
    return a.display.localeCompare(b.display);
  });

  return {
    total: jobs.length,
    commandCount: commands.length,
    totalAttempts,
    commands,
  };
}
