import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parseRateLimitMessage } from "./parser.js";
import type { RelayQueue } from "./queue.js";
import type { NotifyPayload, RelayJob, RetryPolicy } from "./types.js";

export type Notifier = (payload: NotifyPayload) => void | Promise<void>;

export type SpawnFn = (command: string[], cwd: string) => ChildProcessWithoutNullStreams;

const defaultSpawn: SpawnFn = (command, cwd) => {
  const [cmd, ...args] = command;
  return spawn(cmd, args, { cwd });
};

/** Sensible defaults: give up after 10 attempts, backoff 30s → 1m → 2m … capped at 1h. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 10,
  baseDelayMs: 30_000,
  maxDelayMs: 60 * 60_000,
  backoffFactor: 2,
};

export interface SchedulerOptions {
  queue: RelayQueue;
  pollIntervalMs?: number;
  spawnFn?: SpawnFn;
  notify?: Notifier;
  /** Keep the last N chars of combined stdout/stderr for debugging. */
  outputTailLength?: number;
  /** Overrides for the retry/backoff policy; merged over DEFAULT_RETRY_POLICY. */
  retryPolicy?: Partial<RetryPolicy>;
}

interface CommandResult {
  output: string;
  exitCode: number;
  spawnError: Error | null;
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
      processed.push(await this.resume(job));
    }
    return processed;
  }

  private async resume(job: RelayJob): Promise<RelayJob> {
    this.queue.markResuming(job.id);
    // markResuming just incremented attempts; this is the attempt number now running.
    const attempt = job.attempts + 1;
    await this.notify({
      jobId: job.id,
      project: job.project,
      event: "resumed",
      message: `Resuming job for ${job.project} (attempt ${attempt}/${this.retryPolicy.maxAttempts})`,
    });

    const { output, exitCode, spawnError } = await this.runCommand(job);
    const tail = output.slice(-this.outputTailLength);
    const rateLimit = parseRateLimitMessage(output);

    if (rateLimit) {
      // Still rate-limited. Re-queue for the fresh reset time, unless we've
      // exhausted the attempt budget (guards against an infinite relay loop).
      if (attempt >= this.retryPolicy.maxAttempts) {
        return this.giveUp(job, `still rate-limited after ${attempt} attempts (${rateLimit.rawMatch})`, tail);
      }
      this.queue.markWaitingForReset(job.id, rateLimit.resetAt, "rate_limit");
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "queued",
        message: `Hit rate limit again, re-queued until ${rateLimit.resetAt}`,
      });
      return this.queue.getById(job.id)!;
    }

    const failed = spawnError !== null || exitCode !== 0;
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

    // Transient failure (spawn error or non-zero exit, no rate limit): retry
    // with exponential backoff until the attempt budget runs out.
    const reason = spawnError !== null ? String(spawnError) : `command exited with code ${exitCode}`;
    if (attempt >= this.retryPolicy.maxAttempts) {
      return this.giveUp(job, `${reason} (after ${attempt} attempts)`, tail);
    }

    const delayMs = this.backoffDelayMs(attempt);
    const retryAt = new Date(Date.now() + delayMs).toISOString();
    this.queue.markWaitingForReset(job.id, retryAt, "backoff");
    await this.notify({
      jobId: job.id,
      project: job.project,
      event: "retrying",
      message: `Attempt ${attempt} failed (${reason}); backing off ${Math.round(delayMs / 1000)}s, retry at ${retryAt}`,
    });
    return this.queue.getById(job.id)!;
  }

  private async giveUp(job: RelayJob, reason: string, tail: string): Promise<RelayJob> {
    this.queue.markFailed(job.id, `Gave up: ${reason}`, tail);
    await this.notify({
      jobId: job.id,
      project: job.project,
      event: "failed",
      message: `Gave up on ${job.project}: ${reason}`,
    });
    return this.queue.getById(job.id)!;
  }

  /** Exponential backoff for a transient failure, capped at maxDelayMs. */
  private backoffDelayMs(attempt: number): number {
    const { baseDelayMs, backoffFactor, maxDelayMs } = this.retryPolicy;
    const raw = baseDelayMs * Math.pow(backoffFactor, attempt - 1);
    return Math.min(maxDelayMs, Math.round(raw));
  }

  /**
   * Runs the job's command to completion, capturing combined output, exit
   * code, and any spawn error. Never rejects -- all outcomes (including a
   * failed spawn) resolve so the caller's retry logic stays in one place.
   */
  private runCommand(job: RelayJob): Promise<CommandResult> {
    return new Promise((resolve) => {
      let output = "";
      let settled = false;
      const finish = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(job.command, job.cwd);
      } catch (err) {
        finish({ output, exitCode: 1, spawnError: err instanceof Error ? err : new Error(String(err)) });
        return;
      }

      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.on("error", (err) => {
        finish({ output, exitCode: 1, spawnError: err instanceof Error ? err : new Error(String(err)) });
      });
      child.on("close", (code) => {
        finish({ output, exitCode: code ?? 0, spawnError: null });
      });
    });
  }
}
