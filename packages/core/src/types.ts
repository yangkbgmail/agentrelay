export type AgentTool = "claude-code" | "codex-cli" | "generic";

export type JobStatus = "queued" | "waiting_for_reset" | "resuming" | "completed" | "failed";

/** Why a job is currently waiting to be (re)tried. */
export type RetryReason = "rate_limit" | "error";

export interface RetryPolicy {
  /** Total resume attempts allowed before a job is given up on and marked failed. */
  maxAttempts: number;
  /** Base delay for exponential backoff on transient (non-rate-limit) failures, in ms. */
  baseDelayMs: number;
  /** Upper bound on a single backoff delay, in ms. */
  maxDelayMs: number;
  /** Multiplier applied per attempt for exponential backoff. */
  backoffFactor: number;
}

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
  lastError: string | null;
  lastOutputTail: string | null;
  /**
   * When status is `waiting_for_reset`, why: a rate limit (retry at the parsed
   * reset time) or a transient error (retry after exponential backoff). Null
   * otherwise. Optional for backward-compat with jobs written before this field.
   */
  retryReason?: RetryReason | null;
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
