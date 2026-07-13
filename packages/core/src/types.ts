export type AgentTool = "claude-code" | "codex-cli" | "generic";

export type JobStatus =
  | "queued"
  | "waiting_for_reset"
  | "waiting_for_retry"
  | "resuming"
  | "completed"
  | "failed";

export interface RetryPolicy {
  /**
   * Maximum number of resume attempts before a job is permanently failed.
   * Bounds both the rate-limit re-queue loop and transient-failure backoff.
   */
  maxAttempts: number;
  /** Base delay for exponential backoff on transient failures, in ms. */
  baseBackoffMs: number;
  /** Upper bound on any single backoff delay, in ms. */
  maxBackoffMs: number;
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
