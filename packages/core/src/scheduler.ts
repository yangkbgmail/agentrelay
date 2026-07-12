import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parseRateLimitMessage } from "./parser.js";
import type { RelayQueue } from "./queue.js";
import { DEFAULT_RETRY_POLICY, computeBackoffMs, type NotifyPayload, type RelayJob, type RetryPolicy } from "./types.js";

export type Notifier = (payload: NotifyPayload) => void | Promise<void>;

export type SpawnFn = (command: string[], cwd: string) => ChildProcessWithoutNullStreams;

const defaultSpawn: SpawnFn = (command, cwd) => {
  const [cmd, ...args] = command;
  return spawn(cmd, args, { cwd });
};

export interface SchedulerOptions {
  queue: RelayQueue;
  pollIntervalMs?: number;
  spawnFn?: SpawnFn;
  notify?: Notifier;
  /** Keep the last N chars of combined stdout/stderr for debugging. */
  outputTailLength?: number;
  /** How to retry jobs that fail for a transient (non-rate-limit) reason. */
  retryPolicy?: RetryPolicy;
  /** Injectable "now" for deterministic backoff scheduling in tests. */
  now?: () => Date;
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
  private now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SchedulerOptions) {
    this.queue = options.queue;
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.notify = options.notify ?? (() => {});
    this.outputTailLength = options.outputTailLength ?? 2000;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.now = options.now ?? (() => new Date());
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
      // One misbehaving job must never halt the relay loop for the others.
      const result = await this.resume(job).catch(() => this.queue.getById(job.id) ?? null);
      if (result) processed.push(result);
    }
    return processed;
  }

  private async resume(job: RelayJob): Promise<RelayJob> {
    this.queue.markResuming(job.id);
    await this.notify({
      jobId: job.id,
      project: job.project,
      event: "resumed",
      message: `Resuming job for ${job.project} (attempt ${job.attempts + 1})`,
    });

    const { output, exitCode } = await this.runCommand(job);
    const rateLimit = parseRateLimitMessage(output);

    if (rateLimit) {
      // Normal relay path: rate-limited again, wait for the new reset window.
      this.queue.markWaitingForReset(job.id, rateLimit.resetAt);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "queued",
        message: `Hit rate limit again, re-queued until ${rateLimit.resetAt}`,
      });
    } else if (exitCode === 0) {
      this.queue.markCompleted(job.id, output.slice(-this.outputTailLength));
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "completed",
        message: `Job completed for ${job.project}`,
      });
    } else {
      await this.handleTransientFailure(job, exitCode, output);
    }

    return this.queue.getById(job.id)!;
  }

  /**
   * The command exited non-zero without a recognizable rate-limit message.
   * Retry with exponential backoff until `maxRetries` is exhausted, then give
   * up and mark the job failed so it doesn't loop forever.
   */
  private async handleTransientFailure(job: RelayJob, exitCode: number, output: string): Promise<void> {
    const priorRetries = this.queue.getById(job.id)?.retries ?? 0;
    const nextRetry = priorRetries + 1;
    const tail = output.slice(-this.outputTailLength);
    const reason = `Command exited with code ${exitCode}`;

    if (this.retryPolicy.maxRetries > 0 && nextRetry > this.retryPolicy.maxRetries) {
      this.queue.markFailed(job.id, `${reason}; gave up after ${priorRetries} retries`, tail);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "failed",
        message: `Job failed for ${job.project} (${reason}, out of retries)`,
      });
      return;
    }

    const delayMs = computeBackoffMs(nextRetry, this.retryPolicy);
    const nextAttemptAt = new Date(this.now().getTime() + delayMs).toISOString();
    this.queue.markWaitingForRetry(job.id, nextAttemptAt, `${reason} (retry ${nextRetry})`);
    await this.notify({
      jobId: job.id,
      project: job.project,
      event: "queued",
      message: `${reason}; retry ${nextRetry} scheduled for ${nextAttemptAt}`,
    });
  }

  private runCommand(job: RelayJob): Promise<{ output: string; exitCode: number }> {
    return new Promise((resolve) => {
      let output = "";
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(job.command, job.cwd);
      } catch (err) {
        // Treat a failure to even spawn as a transient non-zero exit so it
        // flows through the retry/backoff policy rather than crashing the tick.
        resolve({ output: `${output}\n${String(err)}`, exitCode: 1 });
        return;
      }

      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.on("error", (err) => {
        resolve({ output: `${output}\n${String(err)}`, exitCode: 1 });
      });
      child.on("close", (code) => {
        resolve({ output, exitCode: code ?? 0 });
      });
    });
  }
}
