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
  /** Total resume runs so far (incremented every time the scheduler re-runs the command). */
  attempts: number;
  /**
   * How many times this job was re-queued specifically because the command
   * *failed* (non-zero exit / spawn error), as opposed to hitting a rate
   * limit. Drives the exponential-backoff retry policy and the max-attempts
   * cap. Rate-limit re-queues do NOT increment this — relaying across limit
   * windows is the whole point and is never given up on.
   */
  retryCount: number;
  lastError: string | null;
  lastOutputTail: string | null;
}

/**
 * Controls how failed commands (crashes / non-zero exits, NOT rate limits)
 * are retried before a job is given up on and marked `failed`.
 */
export interface RetryPolicy {
  /**
   * Maximum number of failure retries before giving up. A value <= 0 means
   * "unlimited" (never mark failed for failures alone). Note this counts
   * retries, so `maxRetries: 3` means up to 3 re-runs after the first failure.
   */
  maxRetries: number;
  /** Backoff for the first retry, in milliseconds. */
  baseDelayMs: number;
  /** Upper bound on any single backoff delay, in milliseconds. */
  maxDelayMs: number;
  /** Exponential growth factor applied per retry (e.g. 2 → 1x, 2x, 4x, ...). */
  factor: number;
}

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
