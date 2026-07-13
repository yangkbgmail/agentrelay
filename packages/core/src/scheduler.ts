import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parseRateLimitMessage } from "./parser.js";
import { canRetry, computeBackoffMs, resolveRetryPolicy } from "./retry.js";
import type { RelayQueue } from "./queue.js";
import type { NotifyPayload, RelayJob, RetryPolicy } from "./types.js";

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
  /** Retry/backoff policy; unspecified fields fall back to DEFAULT_RETRY_POLICY. */
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
    this.retryPolicy = resolveRetryPolicy(options.retryPolicy);
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

  private async resume(job: RelayJob, now: Date): Promise<RelayJob> {
    this.queue.markResuming(job.id);
    // `attempts` was just incremented by markResuming; this is the 1-based
    // number of the attempt we are about to make.
    const attempt = this.queue.getById(job.id)?.attempts ?? job.attempts + 1;
    await this.notify({
      jobId: job.id,
      project: job.project,
      event: "resumed",
      message: `Resuming job for ${job.project} (attempt ${attempt})`,
    });

    const { output, error } = await this.runCommand(job);
    const tail = output.slice(-this.outputTailLength);
    const rateLimit = parseRateLimitMessage(output);

    if (rateLimit) {
      if (canRetry(attempt, this.retryPolicy)) {
        this.queue.markWaitingForReset(job.id, rateLimit.resetAt);
        await this.notify({
          jobId: job.id,
          project: job.project,
          event: "queued",
          message: `Hit rate limit again, re-queued until ${rateLimit.resetAt}`,
        });
      } else {
        await this.giveUp(
          job,
          `Rate limit hit again after ${attempt} attempts (max ${this.retryPolicy.maxAttempts}); giving up.`,
          tail
        );
      }
    } else if (error) {
      // Transient failure (spawn/child error): back off and retry instead of
      // failing permanently on the first hiccup.
      if (canRetry(attempt, this.retryPolicy)) {
        const delayMs = computeBackoffMs(attempt, this.retryPolicy);
        const retryAt = new Date(now.getTime() + delayMs).toISOString();
        this.queue.markWaitingForRetry(job.id, retryAt, error, tail);
        await this.notify({
          jobId: job.id,
          project: job.project,
          event: "queued",
          message: `Command failed (${error}); retrying at ${retryAt} (attempt ${attempt}/${this.retryPolicy.maxAttempts}, backoff ${Math.round(delayMs / 1000)}s)`,
        });
      } else {
        await this.giveUp(
          job,
          `Command failed after ${attempt} attempts (max ${this.retryPolicy.maxAttempts}): ${error}`,
          tail
        );
      }
    } else {
      this.queue.markCompleted(job.id, tail);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "completed",
        message: `Job completed for ${job.project}`,
      });
    }

    return this.queue.getById(job.id)!;
  }

  private async giveUp(job: RelayJob, reason: string, tail: string): Promise<void> {
    this.queue.markFailed(job.id, reason, tail);
    await this.notify({
      jobId: job.id,
      project: job.project,
      event: "failed",
      message: reason,
    });
  }

  /**
   * Runs the job's command to completion. Never rejects: transient problems
   * (spawn threw, the child emitted "error") are returned as `error` so the
   * caller can apply the retry policy rather than crashing the tick loop.
   */
  private runCommand(job: RelayJob): Promise<{ output: string; error: string | null }> {
    return new Promise((resolve) => {
      let output = "";
      let settled = false;
      const finish = (error: string | null) => {
        if (settled) return;
        settled = true;
        resolve({ output, error });
      };

      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(job.command, job.cwd);
      } catch (err) {
        finish(String(err));
        return;
      }

      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.on("error", (err) => finish(String(err)));
      child.on("close", () => finish(null));
    });
  }
}
