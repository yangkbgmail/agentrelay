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
 * How many times, and how patiently, the scheduler keeps trying a job.
 *
 * Two distinct kinds of "retry" share this budget:
 *  - Hitting a rate limit *again* on resume. The reset time comes from the
 *    agent's own message, so we simply re-queue for that time (no backoff --
 *    the wait is dictated by the provider, not by us).
 *  - The resumed command genuinely *failing* (non-zero exit, spawn error)
 *    without any rate-limit message. Here we back off exponentially before
 *    retrying, so a persistently-broken command doesn't hammer in a loop.
 *
 * `maxAttempts` counts total resume attempts. Once reached, the job is marked
 * `failed` instead of being re-queued yet again. Set it to 0 for "never give
 * up" (the old behaviour, for rate limits only -- real failures still respect
 * it unless it's 0).
 */
export interface RetryPolicy {
  /** Max total resume attempts before a job is marked failed. 0 = unlimited. */
  maxAttempts: number;
  /** First backoff delay (ms) after a real failure. */
  baseBackoffMs: number;
  /** Upper bound on the backoff delay (ms). */
  maxBackoffMs: number;
  /** Multiplier applied per attempt: delay = base * factor^(attempt-1). */
  backoffFactor: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseBackoffMs: 60_000, // 1 min
  maxBackoffMs: 60 * 60_000, // 1 hour
  backoffFactor: 2,
};

/**
 * Backoff delay for the Nth attempt (1-based), clamped to `maxBackoffMs`.
 * Exported so the CLI/tests can reason about scheduling without duplicating
 * the formula.
 */
export function backoffDelayMs(policy: RetryPolicy, attempt: number): number {
  const raw = policy.baseBackoffMs * Math.pow(policy.backoffFactor, Math.max(0, attempt - 1));
  return Math.min(policy.maxBackoffMs, Math.round(raw));
}

export interface SchedulerOptions {
  queue: RelayQueue;
  pollIntervalMs?: number;
  spawnFn?: SpawnFn;
  notify?: Notifier;
  /** Keep the last N chars of combined stdout/stderr for debugging. */
  outputTailLength?: number;
  /** Retry/backoff/max-attempts policy. Partial values are merged over the default. */
  retry?: Partial<RetryPolicy>;
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
  private retry: RetryPolicy;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SchedulerOptions) {
    this.queue = options.queue;
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.notify = options.notify ?? (() => {});
    this.outputTailLength = options.outputTailLength ?? 2000;
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
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
    // `attempts` reflects the resume we just started (markResuming incremented it).
    const attempt = (this.queue.getById(job.id)?.attempts ?? job.attempts + 1);
    await this.notify({
      jobId: job.id,
      project: job.project,
      event: "resumed",
      message: `Resuming job for ${job.project} (attempt ${attempt})`,
    });

    const { output, exitCode, spawnError } = await this.runCommand(job);
    const tail = output.slice(-this.outputTailLength);
    const rateLimit = parseRateLimitMessage(output);
    const budgetExhausted = this.retry.maxAttempts > 0 && attempt >= this.retry.maxAttempts;

    if (rateLimit) {
      // Provider told us exactly when the window reopens -- honour it, no
      // backoff, unless we've burned through the attempt budget.
      if (budgetExhausted) {
        return this.fail(job, `Gave up after ${attempt} attempts (still rate-limited).`, tail);
      }
      this.queue.markWaitingForReset(job.id, rateLimit.resetAt);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "queued",
        message: `Hit rate limit again (attempt ${attempt}), re-queued until ${rateLimit.resetAt}`,
      });
      return this.queue.getById(job.id)!;
    }

    if (spawnError || exitCode !== 0) {
      // A genuine failure with no rate-limit signal. Back off and retry until
      // the attempt budget is spent, then give up.
      const reason = spawnError ?? `Command exited with code ${exitCode}`;
      if (budgetExhausted) {
        return this.fail(job, `${reason} (gave up after ${attempt} attempts).`, tail);
      }
      const delayMs = backoffDelayMs(this.retry, attempt);
      const retryAt = new Date(now.getTime() + delayMs).toISOString();
      this.queue.markWaitingForReset(job.id, retryAt);
      this.queue.recordError(job.id, reason, tail);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "queued",
        message: `${reason}; retrying attempt ${attempt + 1} at ${retryAt} (backoff ${Math.round(delayMs / 1000)}s)`,
      });
      return this.queue.getById(job.id)!;
    }

    this.queue.markCompleted(job.id, tail);
    await this.notify({
      jobId: job.id,
      project: job.project,
      event: "completed",
      message: `Job completed for ${job.project}`,
    });
    return this.queue.getById(job.id)!;
  }

  private async fail(job: RelayJob, error: string, tail: string): Promise<RelayJob> {
    this.queue.markFailed(job.id, error, tail);
    await this.notify({
      jobId: job.id,
      project: job.project,
      event: "failed",
      message: error,
    });
    return this.queue.getById(job.id)!;
  }

  private runCommand(job: RelayJob): Promise<{ output: string; exitCode: number; spawnError: string | null }> {
    return new Promise((resolve) => {
      let output = "";
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(job.command, job.cwd);
      } catch (err) {
        resolve({ output, exitCode: 1, spawnError: String(err) });
        return;
      }

      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.on("error", (err) => {
        resolve({ output, exitCode: 1, spawnError: String(err) });
      });
      child.on("close", (code) => {
        resolve({ output, exitCode: code ?? 0, spawnError: null });
      });
    });
  }
}
