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
 * Controls how a resumed command that fails for a *non*-rate-limit reason
 * (non-zero exit code, or the process failing to spawn) is retried. Backoff
 * is exponential: `min(maxDelayMs, baseDelayMs * 2 ** retryCount)`. Once a job
 * has been retried `maxAttempts` times it is marked failed instead.
 */
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 60_000, // 1 min
  maxDelayMs: 30 * 60_000, // 30 min
};

/** Exponential backoff delay for the given (zero-based) retry attempt. */
export function backoffDelayMs(retryCount: number, policy: RetryPolicy): number {
  const exp = policy.baseDelayMs * 2 ** Math.max(0, retryCount);
  return Math.min(policy.maxDelayMs, exp);
}

export interface SchedulerOptions {
  queue: RelayQueue;
  pollIntervalMs?: number;
  spawnFn?: SpawnFn;
  notify?: Notifier;
  /** Keep the last N chars of combined stdout/stderr for debugging. */
  outputTailLength?: number;
  /**
   * Retry behaviour for transient (non-rate-limit) failures. Pass `false` to
   * disable retries entirely (failures go straight to `failed`). Defaults to
   * {@link DEFAULT_RETRY_POLICY}.
   */
  retry?: Partial<RetryPolicy> | false;
}

interface RunOutcome {
  output: string;
  exitCode: number;
  spawnError: string | null;
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
  private retry: RetryPolicy | null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SchedulerOptions) {
    this.queue = options.queue;
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.notify = options.notify ?? (() => {});
    this.outputTailLength = options.outputTailLength ?? 2000;
    this.retry =
      options.retry === false ? null : { ...DEFAULT_RETRY_POLICY, ...(options.retry ?? {}) };
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

  private async resume(job: RelayJob, referenceTime: Date): Promise<RelayJob> {
    this.queue.markResuming(job.id);
    await this.notify({
      jobId: job.id,
      project: job.project,
      event: "resumed",
      message: `Resuming job for ${job.project} (attempt ${job.attempts + 1})`,
    });

    const { output, exitCode, spawnError } = await this.runCommand(job);
    const tail = output.slice(-this.outputTailLength);
    const rateLimit = parseRateLimitMessage(output);

    if (rateLimit) {
      // Rate limits are expected, not failures -- re-queue for the new window.
      this.queue.markWaitingForReset(job.id, rateLimit.resetAt);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "queued",
        message: `Hit rate limit again, re-queued until ${rateLimit.resetAt}`,
      });
    } else if (spawnError !== null || exitCode !== 0) {
      // Transient failure: apply the backoff/retry policy.
      const reason = spawnError ?? `command exited with code ${exitCode}`;
      await this.handleFailure(job, reason, tail, referenceTime);
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

  private async handleFailure(
    job: RelayJob,
    reason: string,
    tail: string,
    referenceTime: Date
  ): Promise<void> {
    // job.retryCount is the count *before* this failure; the next retry would
    // be number retryCount + 1.
    if (this.retry && job.retryCount < this.retry.maxAttempts) {
      const delayMs = backoffDelayMs(job.retryCount, this.retry);
      const retryAt = new Date(referenceTime.getTime() + delayMs).toISOString();
      this.queue.markWaitingForRetry(job.id, retryAt, reason, tail);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "retrying",
        message: `${reason}; retry ${job.retryCount + 1}/${this.retry.maxAttempts} scheduled for ${retryAt}`,
      });
    } else {
      this.queue.markFailed(job.id, reason, tail);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "failed",
        message: this.retry
          ? `Job failed after ${job.retryCount} retries: ${reason}`
          : `Job failed: ${reason}`,
      });
    }
  }

  private runCommand(job: RelayJob): Promise<RunOutcome> {
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
        // A spawn/runtime error (e.g. ENOENT). Feed it back as a failure so the
        // retry policy can decide whether to try again -- never throw, or a
        // single bad command would take down the whole relay loop.
        resolve({ output, exitCode: 1, spawnError: String(err) });
      });
      child.on("close", (code) => {
        resolve({ output, exitCode: code ?? 0, spawnError: null });
      });
    });
  }
}
