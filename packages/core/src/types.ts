export type AgentTool = "claude-code" | "codex-cli" | "gemini-cli" | "generic";

export type JobStatus = "queued" | "waiting_for_reset" | "resuming" | "completed" | "failed" | "cancelled";

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

export interface RetryPolicy {
  /**
   * Maximum number of resume attempts before a job is marked `failed`.
   * Counts both rate-limit re-queues and transient-failure retries, so a
   * job that stays rate-limited (or keeps crashing) can't loop forever.
   * Set to 0 for unlimited (e.g. a legitimately long task that keeps
   * hitting the usage window for days).
   */
  maxAttempts: number;
  /** Base backoff delay (ms) applied before the first transient-failure retry. */
  baseDelayMs: number;
  /** Multiplier applied to the delay on each subsequent attempt. */
  factor: number;
  /** Upper bound (ms) on any single backoff delay. */
  maxDelayMs: number;
}

export interface NotifyPayload {
  jobId: string;
  project: string;
  event: "queued" | "resumed" | "completed" | "failed";
  message: string;
}
