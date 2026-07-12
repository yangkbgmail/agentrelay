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
 * Controls how transient failures (non-zero exit, spawn error) are retried.
 * Rate-limit re-runs are NOT governed by this — those always re-queue for the
 * observed reset time. This is only for a resumed command that failed for some
 * other reason (crash, flaky network, transient tool error).
 */
export interface RetryPolicy {
  /** Max number of failure retries before giving up and marking the job failed. */
  maxRetries: number;
  /** Backoff delay for the first retry, in ms. */
  baseDelayMs: number;
  /** Upper bound on any single backoff delay, in ms. */
  maxDelayMs: number;
  /** Exponential growth factor between retries. */
  factor: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 5,
  baseDelayMs: 60_000, // 1 minute
  maxDelayMs: 30 * 60_000, // 30 minutes
  factor: 2,
};

export interface SchedulerOptions {
  queue: RelayQueue;
  pollIntervalMs?: number;
  spawnFn?: SpawnFn;
  notify?: Notifier;
  /** Keep the last N chars of combined stdout/stderr for debugging. */
  outputTailLength?: number;
  /** Retry/backoff policy for transient failures. Partial overrides are merged with defaults. */
  retryPolicy?: Partial<RetryPolicy>;
}

interface RunResult {
  output: string;
  exitCode: number | null;
  error: Error | null;
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

  /** Backoff delay for the Nth failure retry (0-indexed), capped at maxDelayMs. */
  backoffDelayMs(retriesUsed: number): number {
    const raw = this.retryPolicy.baseDelayMs * Math.pow(this.retryPolicy.factor, retriesUsed);
    return Math.min(raw, this.retryPolicy.maxDelayMs);
  }

  private async resume(job: RelayJob, referenceTime: Date): Promise<RelayJob> {
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

    // 1) Rate-limited again -> re-queue for the observed reset time (not a failure).
    if (rateLimit) {
      this.queue.markWaitingForReset(job.id, rateLimit.resetAt);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "queued",
        message: `Hit rate limit again, re-queued until ${rateLimit.resetAt}`,
      });
      return this.queue.getById(job.id)!;
    }

    // 2) Clean exit -> completed.
    const failed = error !== null || (exitCode !== null && exitCode !== 0);
    if (!failed) {
      this.queue.markCompleted(job.id, tail);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "completed",
        message: `Job completed for ${job.project}`,
      });
      return this.queue.getById(job.id)!;
    }

    // 3) Transient failure -> retry with exponential backoff, else give up.
    const errMsg = error ? String(error) : `command exited with code ${exitCode}`;
    const retriesUsed = this.queue.getById(job.id)?.retries ?? 0;
    if (retriesUsed < this.retryPolicy.maxRetries) {
      const delay = this.backoffDelayMs(retriesUsed);
      const retryAt = new Date(referenceTime.getTime() + delay).toISOString();
      this.queue.markRetryScheduled(job.id, retryAt, errMsg, tail);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "queued",
        message: `Attempt failed (${errMsg}); retry ${retriesUsed + 1}/${this.retryPolicy.maxRetries} scheduled at ${retryAt}`,
      });
    } else {
      this.queue.markFailed(job.id, errMsg, tail);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "failed",
        message: `Job failed for ${job.project} after ${this.retryPolicy.maxRetries} retries: ${errMsg}`,
      });
    }

    return this.queue.getById(job.id)!;
  }

  /**
   * Spawns the job's command and resolves with its combined output, exit code,
   * and any spawn/runtime error. Never rejects — the caller (`resume`) owns the
   * decision of completed vs. retry vs. failed.
   */
  private runCommand(job: RelayJob): Promise<RunResult> {
    return new Promise((resolve) => {
      let output = "";
      let settled = false;
      const finish = (result: RunResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(job.command, job.cwd);
      } catch (err) {
        finish({ output, exitCode: null, error: err as Error });
        return;
      }

      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.on("error", (err) => {
        finish({ output, exitCode: null, error: err });
      });
      child.on("close", (code) => {
        finish({ output, exitCode: code ?? 0, error: null });
      });
    });
  }
}
