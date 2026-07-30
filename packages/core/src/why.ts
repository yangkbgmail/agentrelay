// Pure explanation logic for `agentrelay why <id>` — a plain-language answer to
// "what is this job doing right now, and what happens next?".
//
// Where `show <id>` dumps the raw fields of one job (command, cwd, every
// timestamp, error, output tail), `why` *reasons* over those fields: it maps
// the job's status + reset time + retry budget + detection provenance into a
// headline, a few bullet reasons, and a concrete next action the operator can
// take. It's the command you reach for when a job "should have resumed by now"
// and you want the relay to tell you why it hasn't — without eyeballing raw
// timestamps.
//
// Everything here is a pure function of a job snapshot plus an injectable
// `now`, so the reasoning is unit-testable without a clock, a store, or a
// spawned process. The CLI (why.ts) only formats what this module decides.

import { isRetryExhausted } from "./retry.js";
import type { JobStatus, RelayJob, RetryPolicy } from "./types.js";

/**
 * The relay's disposition of a job — a finer-grained view than {@link JobStatus}
 * because a `waiting_for_reset` job splits into two meaningfully different
 * cases: still `waiting` for a future reset, vs. `due` (the reset time has
 * already passed and it's the scheduler's turn to act). That split is exactly
 * the ambiguity `why` exists to resolve.
 */
export type JobDisposition = "queued" | "waiting" | "due" | "resuming" | "completed" | "failed" | "cancelled";

export interface JobExplanation {
  id: string;
  status: JobStatus;
  disposition: JobDisposition;
  /** One-line summary of the job's current state. */
  headline: string;
  /** Supporting bullets: provenance, retry budget, error, etc. */
  reasons: string[];
  /** Concrete guidance: what happens automatically, or what the user can do. */
  nextAction: string;
  /** Ms until the job resumes (>= 0), or null when no resume is scheduled. */
  resumesInMs: number | null;
  attempt: number;
  /** Retry cap from the policy, or null when unlimited (maxAttempts <= 0). */
  maxAttempts: number | null;
  retryExhausted: boolean;
}

export interface ExplainJobOptions {
  /** Injectable "now" (epoch ms) so the countdown/disposition is deterministic. */
  now?: number;
  /** Retry policy governing the attempt budget (defaults handled by caller). */
  retryPolicy?: RetryPolicy;
}

/** First non-empty line of a multi-line error, trimmed — for a compact reason. */
function firstErrorLine(error: string): string {
  for (const line of error.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/** A reason describing where the parked reset time came from, if recorded. */
function detectionReason(job: RelayJob): string | null {
  const detection = job.lastRateLimit;
  if (!detection) return null;
  return `Rate limit detected via pattern \`${detection.pattern}\` from: "${detection.rawMatch}"`;
}

/** A reason summarizing how many attempts have been used against the cap. */
function attemptReason(attempt: number, maxAttempts: number | null): string {
  if (maxAttempts === null) return `Attempt ${attempt} (no retry cap).`;
  return `Attempt ${attempt} of ${maxAttempts}.`;
}

/**
 * Explain a single job's current disposition and next action. Pure: the caller
 * supplies `now` and the retry policy; no I/O, no ambient clock unless `now` is
 * omitted.
 */
export function explainJob(job: RelayJob, options: ExplainJobOptions = {}): JobExplanation {
  const now = options.now ?? Date.now();
  const policy = options.retryPolicy;
  const maxAttempts = policy && policy.maxAttempts > 0 ? policy.maxAttempts : null;
  const retryExhausted = policy ? isRetryExhausted(policy, job.attempts) : false;

  const base = {
    id: job.id,
    status: job.status,
    attempt: job.attempts,
    maxAttempts,
    retryExhausted,
  };

  const detection = detectionReason(job);
  const attempts = attemptReason(job.attempts, maxAttempts);

  switch (job.status) {
    case "queued": {
      const reasons = ["Not parked on a rate-limit reset — it's simply awaiting the next scheduler pass.", attempts];
      if (detection) reasons.unshift(detection);
      return {
        ...base,
        disposition: "queued",
        headline: "Queued — will be picked up on the next scheduler tick.",
        reasons,
        nextAction:
          "If nothing picks it up, make sure a resume loop is running: `agentrelay health` / `agentrelay daemon`.",
        resumesInMs: null,
      };
    }
    case "resuming": {
      const reasons = ["A process has been spawned for this job and the relay is awaiting its exit.", attempts];
      return {
        ...base,
        disposition: "resuming",
        headline: "Resuming now — the command is running.",
        reasons,
        nextAction: "Block on the outcome with `agentrelay wait " + shortId(job.id) + "`.",
        resumesInMs: null,
      };
    }
    case "waiting_for_reset": {
      const resetMs = job.resetAt !== null ? Date.parse(job.resetAt) : Number.NaN;
      const hasReset = !Number.isNaN(resetMs);
      const due = !hasReset || resetMs <= now;
      const reasons: string[] = [];
      if (detection) reasons.push(detection);
      reasons.push(attempts);

      if (due) {
        if (hasReset) reasons.push(`Reset time ${job.resetAt} has already passed.`);
        else reasons.push("No reset time is recorded, so it's treated as due immediately.");
        return {
          ...base,
          disposition: "due",
          headline: "Due now — the reset window has passed; it should resume on the next tick.",
          reasons,
          nextAction:
            "If it isn't resuming, a daemon/tick loop probably isn't running — check `agentrelay health`, then start `agentrelay daemon`.",
          resumesInMs: 0,
        };
      }

      return {
        ...base,
        disposition: "waiting",
        headline: `Waiting for rate-limit reset — resumes at ${job.resetAt}.`,
        reasons,
        nextAction:
          "Nothing to do; it resumes automatically. To resume immediately, run `agentrelay retry " +
          shortId(job.id) +
          "`.",
        resumesInMs: Math.max(0, resetMs - now),
      };
    }
    case "completed": {
      return {
        ...base,
        disposition: "completed",
        headline: "Completed successfully.",
        reasons: [attempts],
        nextAction: "Nothing to do.",
        resumesInMs: null,
      };
    }
    case "failed": {
      const reasons: string[] = [];
      if (retryExhausted && maxAttempts !== null) {
        reasons.push(`Exhausted the retry budget (${job.attempts} of ${maxAttempts} attempts used).`);
      } else {
        reasons.push(attempts);
      }
      if (job.lastError) {
        const line = firstErrorLine(job.lastError);
        if (line) reasons.push(`Last error: ${line}`);
      }
      return {
        ...base,
        disposition: "failed",
        headline: "Failed — the relay gave up on this job.",
        reasons,
        nextAction: "Requeue with a fresh attempt count: `agentrelay retry " + shortId(job.id) + "`.",
        resumesInMs: null,
      };
    }
    case "cancelled": {
      return {
        ...base,
        disposition: "cancelled",
        headline: "Cancelled — a user stopped this job.",
        reasons: [attempts],
        nextAction: "Requeue it with `agentrelay retry " + shortId(job.id) + "`.",
        resumesInMs: null,
      };
    }
  }
}

/** Short id prefix for embedding in suggested commands (matches `status`). */
function shortId(id: string): string {
  return id.slice(0, 8);
}
