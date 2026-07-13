import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parseRateLimitMessage } from "./parser.js";
import type { RelayQueue } from "./queue.js";
import { DEFAULT_RETRY_POLICY, canRetry, computeBackoffMs } from "./retry.js";
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
  /** How failed commands are retried with exponential backoff. */
  retryPolicy?: RetryPolicy;
}

interface CommandResult {
  output: string;
  /** Process exit code, or null if the process failed to run at all. */
  exitCode: number | null;
  /** Set when the process could not be spawned or errored before exiting. */
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
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
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
    await this.notify({
      jobId: job.id,
      project: job.project,
      event: "resumed",
      message: `Resuming job for ${job.project} (attempt ${job.attempts + 1})`,
    });

    const { output, exitCode, spawnError } = await this.runCommand(job);
    const tail = output.slice(-this.outputTailLength);
    // A spawn failure produced no agent output, so there is nothing to scan
    // for a rate-limit message — go straight to the failure path.
    const rateLimit = spawnError ? null : parseRateLimitMessage(output);

    if (rateLimit) {
      // Relaying across a fresh limit window — never counts as a failure retry.
      this.queue.markWaitingForReset(job.id, rateLimit.resetAt);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "queued",
        message: `Hit rate limit again, re-queued until ${rateLimit.resetAt}`,
      });
      return this.queue.getById(job.id)!;
    }

    const failed = spawnError !== null || (exitCode ?? 1) !== 0;
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

    // Command failed. Apply the exponential-backoff retry policy.
    const errorMessage = spawnError ? String(spawnError) : `command exited with code ${exitCode}`;
    const retriesUsed = job.retryCount ?? 0;

    if (canRetry(this.retryPolicy, retriesUsed)) {
      const delayMs = computeBackoffMs(this.retryPolicy, retriesUsed + 1);
      const retryAt = new Date(now.getTime() + delayMs).toISOString();
      this.queue.markRetry(job.id, retryAt, errorMessage, tail);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "queued",
        message: `Command failed (${errorMessage}); retry ${retriesUsed + 1}/${this.retryPolicy.maxRetries} scheduled for ${retryAt}`,
      });
    } else {
      this.queue.markFailed(job.id, errorMessage, tail);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "failed",
        message: `Command failed after ${retriesUsed} retr${retriesUsed === 1 ? "y" : "ies"}: ${errorMessage}`,
      });
    }

    return this.queue.getById(job.id)!;
  }

  /**
   * Runs the job's command to completion. Always resolves (never rejects) with
   * the captured output plus how it terminated, so the caller owns all the
   * success/retry/fail decision-making in one place.
   */
  private runCommand(job: RelayJob): Promise<CommandResult> {
    return new Promise((resolve) => {
      let output = "";
      let settled = false;
      const settle = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(job.command, job.cwd);
      } catch (err) {
        settle({ output: "", exitCode: null, spawnError: err as Error });
        return;
      }

      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.on("error", (err) => {
        settle({ output, exitCode: null, spawnError: err });
      });
      child.on("close", (code) => {
        settle({ output, exitCode: code ?? 0, spawnError: null });
      });
    });
  }
}
