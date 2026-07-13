export type AgentTool = "claude-code" | "codex-cli" | "generic";

export type JobStatus =
  | "queued"
  | "waiting_for_reset"
  | "waiting_for_retry"
  | "resuming"
  | "completed"
  | "failed";

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
  /**
   * When the job becomes due again. Used both for rate-limit resets
   * (`waiting_for_reset`) and for backoff retries (`waiting_for_retry`).
   */
  resetAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Total number of times this job's command has been (re-)run. */
  attempts: number;
  /**
   * Consecutive transient-failure retries (non-zero exit / spawn error that
   * is not a rate limit). Reset to 0 on any successful run or rate-limit
   * re-queue, and bounded by the scheduler's retry policy.
   */
  retryCount: number;
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
  event: "queued" | "resumed" | "retrying" | "completed" | "failed";
  message: string;
}
