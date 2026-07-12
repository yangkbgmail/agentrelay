import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parseRateLimitMessage } from "./parser.js";
import type { RelayQueue } from "./queue.js";
import type { NotifyPayload, RelayJob } from "./types.js";

export type Notifier = (payload: NotifyPayload) => void | Promise<void>;

export type SpawnFn = (command: string[], cwd: string) => ChildProcessWithoutNullStreams;

const defaultSpawn: SpawnFn = (command, cwd) => {
  const [cmd, ...args] = command;
  return spawn(cmd, args, { cwd });
};

/**
 * How a job that *fails* (non-zero exit or spawn error, and no rate-limit
 * message to explain it) should be retried. This is distinct from the
 * rate-limit relay loop: a rate limit is an expected pause, whereas a failure
 * is a genuine error that we retry a bounded number of times with growing
 * backoff before giving up.
 */
export interface RetryPolicy {
  /** Max consecutive transient failures before a job is marked failed. */
  maxAttempts: number;
  /** First backoff delay; doubles each subsequent failure. */
  baseBackoffMs: number;
  /** Upper bound on the backoff delay. */
  maxBackoffMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseBackoffMs: 30_000,
  maxBackoffMs: 30 * 60_000,
};

/** Backoff for the Nth consecutive failure (1-indexed): base * 2^(n-1), capped. */
export function computeBackoffMs(policy: RetryPolicy, failureCount: number): number {
  const exponent = Math.max(0, failureCount - 1);
  const raw = policy.baseBackoffMs * 2 ** exponent;
  return Math.min(raw, policy.maxBackoffMs);
}

interface RunResult {
  output: string;
  /** Process exit code, or null when the process errored before exiting. */
  exitCode: number | null;
  /** Set when the process could not be spawned or emitted an "error" event. */
  error?: string;
}

export interface SchedulerOptions {
  queue: RelayQueue;
  pollIntervalMs?: number;
  spawnFn?: SpawnFn;
  notify?: Notifier;
  /** Keep the last N chars of combined stdout/stderr for debugging. */
  outputTailLength?: number;
  /** Retry policy for genuine command failures. Defaults to DEFAULT_RETRY_POLICY. */
  retryPolicy?: Partial<RetryPolicy>;
}

/**
 * Polls the queue for jobs whose rate-limit reset time has passed, and
 * re-runs the original command. If the command hits a rate limit again,
 * the job is re-queued for the new reset time instead of being marked
 * failed -- this is the core "keep relaying across limit windows" loop.
 */
export class RelayScheduler {
  private queue: RelayQueue;
  private pollIntervalMs: number;
  private spawnFn: SpawnFn;
  private notify: Notifier;
  private outputTailLength: number;
  private retryPolicy: RetryPolicy;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SchedulerOptions) {
    this.queue = options.queue;
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.notify = options.notify ?? (() => {});
    this.outputTailLength = options.outputTailLength ?? 2000;
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retryPolicy };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs one polling cycle immediately. Exposed for tests and manual `agentrelay tick`. */
  async tick(referenceTime: Date = new Date()): Promise<RelayJob[]> {
    const due = this.queue.listDue(referenceTime);
    const processed: RelayJob[] = [];
    for (const job of due) {
      processed.push(await this.resume(job, referenceTime));
    }
    return processed;
  }

  private async resume(job: RelayJob, referenceTime: Date = new Date()): Promise<RelayJob> {
    this.queue.markResuming(job.id);
    await this.notify({
      jobId: job.id,
      project: job.project,
      event: "resumed",
      message: `Resuming job for ${job.project} (attempt ${job.attempts + 1})`,
    });

    const { output, exitCode, error } = await this.runCommand(job);
    const tail = output.slice(-this.outputTailLength);
    const rateLimit = parseRateLimitMessage(output);

    if (rateLimit) {
      // Expected pause, not a failure -- relay across the new window and reset
      // the failure counter.
      this.queue.markWaitingForReset(job.id, rateLimit.resetAt);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "queued",
        message: `Hit rate limit again, re-queued until ${rateLimit.resetAt}`,
      });
    } else if (error === undefined && exitCode === 0) {
      this.queue.markCompleted(job.id, tail);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "completed",
        message: `Job completed for ${job.project}`,
      });
    } else {
      // Genuine failure (spawn error or non-zero exit with no rate-limit hint).
      await this.handleFailure(job, referenceTime, error ?? `exited with code ${exitCode}`, tail);
    }

    return this.queue.getById(job.id)!;
  }

  /** Apply the retry policy: back off and re-queue, or give up once exhausted. */
  private async handleFailure(
    job: RelayJob,
    referenceTime: Date,
    error: string,
    tail: string
  ): Promise<void> {
    const failureCount = (job.retryCount ?? 0) + 1;
    if (failureCount >= this.retryPolicy.maxAttempts) {
      this.queue.markFailed(job.id, error, tail);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "failed",
        message: `Job failed for ${job.project} after ${failureCount} attempt(s): ${error}`,
      });
      return;
    }

    const backoffMs = computeBackoffMs(this.retryPolicy, failureCount);
    const resumeAt = new Date(referenceTime.getTime() + backoffMs).toISOString();
    this.queue.markRetry(job.id, resumeAt, error, tail);
    await this.notify({
      jobId: job.id,
      project: job.project,
      event: "queued",
      message: `Job failed for ${job.project} (${error}); retry ${failureCount}/${this.retryPolicy.maxAttempts} scheduled for ${resumeAt}`,
    });
  }

  private runCommand(job: RelayJob): Promise<RunResult> {
    return new Promise((resolve) => {
      let output = "";
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(job.command, job.cwd);
      } catch (err) {
        resolve({ output, exitCode: null, error: String(err) });
        return;
      }

      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.on("error", (err) => {
        resolve({ output, exitCode: null, error: String(err) });
      });
      child.on("close", (code) => {
        // `code` is null when the process was terminated by a signal -- that's
        // not a clean exit, so we leave it null and let the failure path handle it.
        resolve({ output, exitCode: code });
      });
    });
  }
}
