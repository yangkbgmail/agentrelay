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
  attempts: number;
  /**
   * Number of transient (non-rate-limit) failures this job has hit. Used to
   * enforce the retry cap and compute exponential backoff. Distinct from
   * `attempts`, which counts every resume including normal rate-limit re-runs.
   */
  retries: number;
  lastError: string | null;
  lastOutputTail: string | null;
}

/**
 * Controls how the scheduler retries a job that fails for a transient reason
 * (the command exited non-zero without a recognizable rate-limit message).
 * Rate-limit re-queues are the product's normal path and are never capped by
 * this policy -- only genuine command failures are.
 */
export interface RetryPolicy {
  /** Max transient failures before a job is marked permanently failed. 0 = unlimited. */
  maxRetries: number;
  /** Base delay for exponential backoff, in ms (attempt 1 waits this long). */
  backoffBaseMs: number;
  /** Upper bound on a single backoff delay, in ms. */
  backoffMaxMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  backoffBaseMs: 60_000,
  backoffMaxMs: 60 * 60_000,
};

/**
 * Exponential backoff delay for the Nth transient retry (1-indexed), capped at
 * `backoffMaxMs`. retry 1 -> base, retry 2 -> 2*base, retry 3 -> 4*base, ...
 */
export function computeBackoffMs(retry: number, policy: RetryPolicy): number {
  const n = Math.max(1, retry);
  const raw = policy.backoffBaseMs * 2 ** (n - 1);
  return Math.min(raw, policy.backoffMaxMs);
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
