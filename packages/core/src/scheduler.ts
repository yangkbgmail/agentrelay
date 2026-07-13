import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parseRateLimitMessage } from "./parser.js";
import type { RelayQueue } from "./queue.js";
import { DEFAULT_RETRY_POLICY, type NotifyPayload, type RelayJob, type RetryPolicy } from "./types.js";

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
  /** Overrides for how genuinely-failing commands are retried. */
  retryPolicy?: Partial<RetryPolicy>;
}

/** Result of running one command attempt. Never throws for the caller. */
interface RunResult {
  output: string;
  /** Process exit code, or null if it never started / was killed by a signal. */
  exitCode: number | null;
  /** Set when the process could not be spawned or errored before exiting. */
  spawnError: string | null;
}

/**
 * Backoff delay before the next failure retry: `min(maxDelayMs,
 * baseDelayMs * factor^failureCount)`. `failureCount` is how many failures
 * have already been recorded, so the first retry uses `baseDelayMs`.
 */
export function computeBackoffDelay(policy: RetryPolicy, failureCount: number): number {
  const raw = policy.baseDelayMs * Math.pow(policy.backoffFactor, Math.max(0, failureCount));
  return Math.min(policy.maxDelayMs, Math.round(raw));
}

/**
 * Builds a retry-policy override from environment variables, falling back to
 * `DEFAULT_RETRY_POLICY` for anything unset or unparseable. Lets operators tune
 * the daemon/tick without code changes:
 *   AGENTRELAY_RETRY_MAX_ATTEMPTS, AGENTRELAY_RETRY_BASE_MS,
 *   AGENTRELAY_RETRY_FACTOR, AGENTRELAY_RETRY_MAX_MS
 */
export function retryPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<RetryPolicy> {
  const num = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const policy: Partial<RetryPolicy> = {};
  const maxAttempts = num(env.AGENTRELAY_RETRY_MAX_ATTEMPTS);
  const baseDelayMs = num(env.AGENTRELAY_RETRY_BASE_MS);
  const backoffFactor = num(env.AGENTRELAY_RETRY_FACTOR);
  const maxDelayMs = num(env.AGENTRELAY_RETRY_MAX_MS);
  if (maxAttempts !== undefined) policy.maxAttempts = maxAttempts;
  if (baseDelayMs !== undefined) policy.baseDelayMs = baseDelayMs;
  if (backoffFactor !== undefined) policy.backoffFactor = backoffFactor;
  if (maxDelayMs !== undefined) policy.maxDelayMs = maxDelayMs;
  return policy;
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
      // One misbehaving job must never abort the whole cycle -- resume swallows
      // its own errors and always returns the job's latest persisted state.
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
    const rateLimit = parseRateLimitMessage(output);

    if (rateLimit) {
      // Rate limits are the expected case -- always relay to the reset time,
      // never counted against the failure-retry cap.
      this.queue.markWaitingForReset(job.id, rateLimit.resetAt);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "queued",
        message: `Hit rate limit again, re-queued until ${rateLimit.resetAt}`,
      });
    } else if (spawnError !== null || (exitCode !== null && exitCode !== 0)) {
      const reason = spawnError ?? `command exited with code ${exitCode}`;
      await this.handleFailure(job, reason, output, referenceTime);
    } else {
      this.queue.markCompleted(job.id, output.slice(-this.outputTailLength));
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "completed",
        message: `Job completed for ${job.project}`,
      });
    }

    return this.queue.getById(job.id)!;
  }

  /**
   * Handles a genuinely-failed run (non-zero exit or spawn error). Retries with
   * exponential backoff until the policy's `maxAttempts` is exhausted, then
   * marks the job `failed` so it stops consuming resume cycles.
   */
  private async handleFailure(job: RelayJob, reason: string, output: string, referenceTime: Date): Promise<void> {
    const current = this.queue.getById(job.id);
    const failuresSoFar = current?.failureRetries ?? 0;
    const tail = output.slice(-this.outputTailLength);

    if (failuresSoFar >= this.retryPolicy.maxAttempts) {
      this.queue.markFailed(job.id, `${reason} (gave up after ${failuresSoFar} retries)`, tail);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "failed",
        message: `Job failed for ${job.project}: ${reason} (max retries reached)`,
      });
      return;
    }

    const delay = computeBackoffDelay(this.retryPolicy, failuresSoFar);
    const retryAt = new Date(referenceTime.getTime() + delay).toISOString();
    this.queue.markRetry(job.id, retryAt, reason);
    await this.notify({
      jobId: job.id,
      project: job.project,
      event: "queued",
      message: `Command failed (${reason}); retry ${failuresSoFar + 1}/${this.retryPolicy.maxAttempts} scheduled for ${retryAt}`,
    });
  }

  private runCommand(job: RelayJob): Promise<RunResult> {
    return new Promise((resolve) => {
      let output = "";
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(job.command, job.cwd);
      } catch (err) {
        resolve({ output, exitCode: null, spawnError: String(err) });
        return;
      }

      let settled = false;
      const finish = (result: RunResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.on("error", (err) => {
        finish({ output, exitCode: null, spawnError: String(err) });
      });
      child.on("close", (code) => {
        finish({ output, exitCode: code ?? 0, spawnError: null });
      });
    });
  }
}
