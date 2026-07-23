export type AgentTool = "claude-code" | "codex-cli" | "generic";

export type JobStatus = "queued" | "waiting_for_reset" | "resuming" | "completed" | "failed" | "cancelled";

export interface RateLimitInfo {
  /** ISO timestamp when the rate limit is expected to reset. */
  resetAt: string;
  /** Raw text that was matched, kept for debugging/audit. */
  rawMatch: string;
  /** Which known message pattern matched. */
  pattern: string;
}

/**
 * Provenance of the rate-limit that most recently parked a job in
 * `waiting_for_reset`: which parser pattern matched, the raw text it matched,
 * the reset it produced, and when it was recorded. Persisted on the job so
 * `agentrelay show` (and the dashboard) can answer the #1 debugging question —
 * *why* does the relay think the reset is at that time? Without this, the only
 * hint that a detection happened is a one-off console line at enqueue time,
 * long gone by the time someone inspects a queued job.
 */
export interface RateLimitDetection {
  /** Name of the parser pattern that matched (see parser.ts / adapters.ts). */
  pattern: string;
  /** The raw substring of the agent output that matched. */
  rawMatch: string;
  /** ISO timestamp of the reset this detection produced. */
  resetAt: string;
  /** ISO timestamp when the detection was recorded. */
  detectedAt: string;
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
   * Provenance of the last rate-limit detection that parked this job (see
   * {@link RateLimitDetection}). Optional so stores written before this field
   * existed load without migration; `null` once a job has been touched but no
   * rate limit has been detected yet.
   */
  lastRateLimit?: RateLimitDetection | null;
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
