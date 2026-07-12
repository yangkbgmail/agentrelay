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

/** Why a job is currently sitting in `waiting_for_reset`. */
export type WaitReason = "rate_limit" | "backoff";

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
  attempts: number;
  lastError: string | null;
  lastOutputTail: string | null;
  /**
   * Distinguishes a legitimate rate-limit wait from a backoff wait after a
   * transient command failure. Optional so older store files stay readable.
   */
  waitReason?: WaitReason | null;
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
  event: "queued" | "resumed" | "retrying" | "completed" | "failed";
  message: string;
}

/**
 * Controls how the scheduler retries jobs. `maxAttempts` caps both
 * rate-limit re-queues and transient-failure retries so a job can never loop
 * forever. Transient failures (non-zero exit / spawn error, with no
 * rate-limit detected) are retried with exponential backoff.
 */
export interface RetryPolicy {
  /** Hard cap on total resume attempts before a job is marked failed. */
  maxAttempts: number;
  /** First backoff delay after a transient failure. */
  baseDelayMs: number;
  /** Upper bound on any single backoff delay. */
  maxDelayMs: number;
  /** Multiplier applied to the delay after each failed attempt. */
  backoffFactor: number;
}
