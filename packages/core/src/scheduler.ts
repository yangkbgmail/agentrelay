import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parseRateLimitMessage } from "./parser.js";
import { DEFAULT_RETRY_POLICY, backoffDelayMs } from "./retry.js";
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
  /** How many times to retry, and how to back off transient failures. */
  retryPolicy?: RetryPolicy;
}

interface CommandResult {
  output: string;
  /** Process exit code, or null if the process was killed by a signal / never spawned. */
  exitCode: number | null;
  /** Set when the process could not be spawned or emitted an "error" event. */
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

  private async resume(job: RelayJob, referenceTime: Date): Promise<RelayJob> {
    this.queue.markResuming(job.id);
    // markResuming just bumped the stored count to job.attempts + 1; that's the
    // attempt we're about to make. Compare it against the policy cap.
    const attemptNumber = job.attempts + 1;
    await this.notify({
      jobId: job.id,
      project: job.project,
      event: "resumed",
      message: `Resuming job for ${job.project} (attempt ${attemptNumber})`,
    });

    const { output, exitCode, spawnError } = await this.runCommand(job);
    const tail = output.slice(-this.outputTailLength);
    const rateLimit = parseRateLimitMessage(output);

    if (rateLimit) {
      // Rate limit hit again: retry at the parsed reset time, not via backoff --
      // but still give up once we've burned through the attempt budget.
      if (attemptNumber >= this.retryPolicy.maxAttempts) {
        const msg = `Gave up after ${attemptNumber} attempts: still rate-limited (resets ${rateLimit.resetAt})`;
        this.queue.markFailed(job.id, msg, tail);
        await this.notify({ jobId: job.id, project: job.project, event: "failed", message: msg });
      } else {
        this.queue.markWaitingForReset(job.id, rateLimit.resetAt, { retryReason: "rate_limit", lastError: null });
        await this.notify({
          jobId: job.id,
          project: job.project,
          event: "queued",
          message: `Hit rate limit again, re-queued until ${rateLimit.resetAt}`,
        });
      }
      return this.queue.getById(job.id)!;
    }

    const failure = spawnError ?? (exitCode !== null && exitCode !== 0 ? `command exited with code ${exitCode}` : null);
    if (!failure) {
      this.queue.markCompleted(job.id, tail);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "completed",
        message: `Job completed for ${job.project}`,
      });
      return this.queue.getById(job.id)!;
    }

    // Transient failure (crash / non-zero exit / spawn error) with no rate-limit
    // message: retry with exponential backoff until the attempt budget runs out.
    if (attemptNumber >= this.retryPolicy.maxAttempts) {
      const msg = `Gave up after ${attemptNumber} attempts: ${failure}`;
      this.queue.markFailed(job.id, msg, tail);
      await this.notify({ jobId: job.id, project: job.project, event: "failed", message: msg });
    } else {
      const delayMs = backoffDelayMs(attemptNumber, this.retryPolicy);
      const retryAt = new Date(referenceTime.getTime() + delayMs).toISOString();
      this.queue.markWaitingForReset(job.id, retryAt, { retryReason: "error", lastError: failure });
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "queued",
        message: `Command failed (${failure}); retrying in ${Math.round(delayMs / 1000)}s at ${retryAt}`,
      });
    }
    return this.queue.getById(job.id)!;
  }

  /**
   * Runs the job's command to completion, collecting combined stdout/stderr.
   * Never rejects: spawn failures and "error" events are surfaced via
   * `spawnError`/`exitCode` so the caller can apply the retry policy uniformly.
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
        settle({ output: "", exitCode: null, spawnError: String(err) });
        return;
      }

      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.on("error", (err) => {
        settle({ output, exitCode: null, spawnError: String(err) });
      });
      child.on("close", (code) => {
        settle({ output, exitCode: code ?? null, spawnError: null });
      });
    });
  }
}
