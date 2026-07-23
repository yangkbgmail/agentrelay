import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { resolveAdapter } from "./adapters.js";
import { type PruneOptions, shouldAutoPrune, shouldAutoPruneByTicks } from "./prune.js";
import type { RelayQueue } from "./queue.js";
import { computeBackoffMs, DEFAULT_RETRY_POLICY, isRetryExhausted } from "./retry.js";
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
  /** Retry/backoff/max-attempts policy. Defaults to {@link DEFAULT_RETRY_POLICY}. */
  retryPolicy?: RetryPolicy;
  /**
   * Random source (returning `[0, 1)`) used only to spread backoff delays when
   * `retryPolicy.jitter > 0`. Defaults to {@link Math.random}; inject a fixed
   * function in tests to make jittered delays deterministic. Never consulted
   * while `jitter` is 0 (the default), so normal runs stay reproducible.
   */
  rng?: () => number;
  /**
   * When set, finished jobs matching these options are pruned from the store
   * after every tick, keeping a long-running daemon's JSON store bounded
   * without a separate cron. `null`/omitted disables auto-prune.
   */
  autoPrune?: PruneOptions | null;
  /**
   * Minimum wall-clock interval (ms) between auto-prune passes. When set, a
   * prune runs at most once per this window even though {@link tick} fires more
   * often, so a fast-polling daemon doesn't rewrite the store every tick. The
   * first tick always prunes; `undefined`/`0` keeps the prune-every-tick
   * behavior. Only affects the long-running scheduler — a fresh process (e.g.
   * one-shot `agentrelay tick`) starts with no prior-pass memory.
   */
  autoPruneEveryMs?: number;
  /**
   * Minimum number of ticks between auto-prune passes. When set, a prune runs at
   * most once per this many ticks; the first tick always prunes. Composes with
   * {@link autoPruneEveryMs} — when both are set, a pass runs only when *both*
   * throttles permit it. `undefined`/`0` disables the tick throttle. Like the
   * time throttle, only meaningful for the long-running scheduler.
   */
  autoPruneEveryTicks?: number;
  /** Called with the jobs an auto-prune pass removed (for logging). */
  onPrune?: (pruned: RelayJob[]) => void;
  /**
   * Called at the end of every tick with the tick's reference time, whether or
   * not any job was due. The daemon uses this to refresh its liveness heartbeat
   * so `agentrelay doctor` can tell the resume loop is alive. Kept as a callback
   * (not file I/O here) so the scheduler stays free of heartbeat-file concerns;
   * any error it throws is swallowed so store maintenance can't break relaying.
   */
  onTick?: (referenceTime: Date) => void | Promise<void>;
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
  private rng: () => number;
  private autoPrune: PruneOptions | null;
  private autoPruneEveryMs: number;
  private autoPruneEveryTicks: number;
  private lastPruneAtMs: number | null = null;
  private pruneTickCounter = 0;
  private onPrune?: (pruned: RelayJob[]) => void;
  private onTick?: (referenceTime: Date) => void | Promise<void>;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SchedulerOptions) {
    this.queue = options.queue;
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.notify = options.notify ?? (() => {});
    this.outputTailLength = options.outputTailLength ?? 2000;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.rng = options.rng ?? Math.random;
    this.autoPrune = options.autoPrune ?? null;
    this.autoPruneEveryMs = options.autoPruneEveryMs ?? 0;
    this.autoPruneEveryTicks = options.autoPruneEveryTicks ?? 0;
    this.onPrune = options.onPrune;
    this.onTick = options.onTick;
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
    this.runAutoPrune(referenceTime);
    // Refresh liveness last, so a heartbeat write reflects a fully completed
    // tick. Best-effort: a failing hook must never stop the relay loop.
    if (this.onTick) {
      try {
        await this.onTick(referenceTime);
      } catch {
        // Ignore — liveness bookkeeping is best-effort.
      }
    }
    return processed;
  }

  /**
   * Sweep finished jobs after a tick when auto-prune is configured. Store
   * maintenance must never break the relay loop, so any failure is swallowed
   * (the next tick will try again). The tick's `referenceTime` is reused as the
   * age cutoff's "now" so pruning is deterministic alongside job processing.
   *
   * Passes can be throttled by wall-clock time (`autoPruneEveryMs`) and/or tick
   * count (`autoPruneEveryTicks`) so a fast-polling daemon doesn't rewrite the
   * store on every tick. When both are set a pass runs only when *both* permit
   * it. The tick counter advances every tick (so the tick throttle stays on
   * cadence), while the time marker advances only when a pass actually runs —
   * regardless of whether it removed anything.
   */
  private runAutoPrune(referenceTime: Date): void {
    if (!this.autoPrune) return;
    const nowMs = referenceTime.getTime();
    const tickIndex = this.pruneTickCounter++;
    const tickAllows = shouldAutoPruneByTicks(tickIndex, this.autoPruneEveryTicks);
    const timeAllows = shouldAutoPrune(this.lastPruneAtMs, nowMs, this.autoPruneEveryMs);
    if (!tickAllows || !timeAllows) return;
    this.lastPruneAtMs = nowMs;
    try {
      const pruned = this.queue.prune({ ...this.autoPrune, now: referenceTime });
      if (pruned.length > 0) this.onPrune?.(pruned);
    } catch {
      // Ignore — bounding the store is best-effort and must not stop relaying.
    }
  }

  private async resume(job: RelayJob, referenceTime: Date): Promise<RelayJob> {
    this.queue.markResuming(job.id);
    // markResuming just bumped attempts; this is the attempt we're running now.
    const attemptNumber = job.attempts + 1;
    await this.notify({
      jobId: job.id,
      project: job.project,
      event: "resumed",
      message: `Resuming job for ${job.project} (attempt ${attemptNumber})`,
    });

    const { output, exitCode, error } = await this.runCommand(job);
    const tail = output.slice(-this.outputTailLength);
    // Use the tool's adapter so tool-specific rate-limit wording (e.g. Codex's
    // seconds-based waits) is recognized on resume, not just at enqueue time.
    const rateLimit = resolveAdapter({ tool: job.tool, command: job.command }).detectRateLimit(output);

    // Rate limit takes priority over exit code: agent CLIs commonly exit
    // non-zero when they hit a limit, and that's an expected relay, not a crash.
    if (rateLimit) {
      if (isRetryExhausted(this.retryPolicy, attemptNumber)) {
        const msg = `Still rate-limited after ${attemptNumber} attempt(s); giving up (maxAttempts=${this.retryPolicy.maxAttempts}).`;
        this.queue.markFailed(job.id, msg, tail);
        await this.notify({ jobId: job.id, project: job.project, event: "failed", message: msg });
      } else {
        this.queue.markWaitingForReset(job.id, rateLimit.resetAt, {
          pattern: rateLimit.pattern,
          rawMatch: rateLimit.rawMatch,
          resetAt: rateLimit.resetAt,
          detectedAt: new Date().toISOString(),
        });
        await this.notify({
          jobId: job.id,
          project: job.project,
          event: "queued",
          message: `Hit rate limit again, re-queued until ${rateLimit.resetAt}`,
        });
      }
      return this.reload(job.id);
    }

    const failed = error !== null || (exitCode !== null && exitCode !== 0);
    if (!failed) {
      this.queue.markCompleted(job.id, tail);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "completed",
        message: `Job completed for ${job.project}`,
      });
      return this.reload(job.id);
    }

    // Transient failure (spawn error or non-zero exit with no rate-limit signal):
    // back off exponentially and retry, until the attempt cap is reached.
    const reason = error ? String(error) : `command exited with code ${exitCode}`;
    if (isRetryExhausted(this.retryPolicy, attemptNumber)) {
      const msg = `Failed after ${attemptNumber} attempt(s): ${reason}`;
      this.queue.markFailed(job.id, msg, tail);
      await this.notify({ jobId: job.id, project: job.project, event: "failed", message: msg });
    } else {
      const delayMs = computeBackoffMs(this.retryPolicy, attemptNumber, this.rng);
      const retryAt = new Date(referenceTime.getTime() + delayMs).toISOString();
      this.queue.markRetryScheduled(
        job.id,
        retryAt,
        `${reason} — backing off ${Math.round(delayMs / 1000)}s (attempt ${attemptNumber})`
      );
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "queued",
        message: `Attempt ${attemptNumber} failed (${reason}); retrying at ${retryAt}`,
      });
    }
    return this.reload(job.id);
  }

  /** Re-read a job we just persisted; it must still exist. */
  private reload(id: string): RelayJob {
    const job = this.queue.getById(id);
    if (!job) throw new Error(`Job ${id} vanished from the queue`);
    return job;
  }

  private runCommand(job: RelayJob): Promise<{ output: string; exitCode: number | null; error: Error | null }> {
    return new Promise((resolve) => {
      let output = "";
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(job.command, job.cwd);
      } catch (err) {
        // Synchronous spawn failure (e.g. bad cwd) — surface as a transient error
        // so the caller can apply the retry policy rather than dropping the job.
        resolve({ output, exitCode: null, error: err as Error });
        return;
      }

      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.on("error", (err) => {
        resolve({ output, exitCode: null, error: err as Error });
      });
      child.on("close", (code) => {
        resolve({ output, exitCode: code ?? 0, error: null });
      });
    });
  }
}
