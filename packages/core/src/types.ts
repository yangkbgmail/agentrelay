export type AgentTool = "claude-code" | "codex-cli" | "generic";

export type JobStatus = "queued" | "waiting_for_reset" | "resuming" | "completed" | "failed";

export interface RateLimitInfo {
  /** ISO timestamp when the rate limit is expected to reset. */
  resetAt: string;
  /** Raw text that was matched, kept for debugging/audit. */
  rawMatch: string;
  /** Which known message pattern matched. */
  pattern: string;
}

export interface RelayJob {
  id: string;
  project: string;
  tool: AgentTool;
  /** The original command that got rate-limited, e.g. ["claude", "-p", "continue the refactor"] */
  command: string[];
  /** Working directory the command should run in. */
  cwd: string;
  status: JobStatus;
  resetAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Total number of times the command has been (re-)run by the scheduler. */
  attempts: number;
  /**
   * How many times this job has been retried specifically because the command
   * *failed* (non-zero exit / spawn error) rather than hitting a rate limit.
   * Rate-limit re-queues do not count toward this -- relaying across limit
   * windows is the whole point and must never be capped. This counter is what
   * the retry policy's `maxAttempts` is checked against.
   */
  failureRetries: number;
  lastError: string | null;
  lastOutputTail: string | null;
}

/**
 * Controls how the scheduler retries a job whose command genuinely fails
 * (exits non-zero without a recognizable rate-limit message). Rate-limit
 * relays are unaffected by this -- they are always re-queued for the reset
 * time. Delays grow exponentially: `min(maxDelayMs, baseDelayMs * factor^n)`
 * where `n` is the number of failures already recorded.
 */
export interface RetryPolicy {
  /** Max failure-retries before the job is marked `failed`. */
  maxAttempts: number;
  /** Delay before the first retry. */
  baseDelayMs: number;
  /** Multiplier applied per subsequent retry. */
  backoffFactor: number;
  /** Upper bound on any single backoff delay. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 60_000, // 1 minute
  backoffFactor: 3,
  maxDelayMs: 60 * 60_000, // 1 hour
};

export interface CreateJobInput {
  project: string;
  tool: AgentTool;
  command: string[];
  cwd: string;
}

export interface NotifyPayload {
  jobId: string;
  project: string;
  event: "queued" | "resumed" | "completed" | "failed";
  message: string;
}
