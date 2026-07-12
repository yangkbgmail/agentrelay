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

export interface SchedulerOptions {
  queue: RelayQueue;
  pollIntervalMs?: number;
  spawnFn?: SpawnFn;
  notify?: Notifier;
  /** Keep the last N chars of combined stdout/stderr for debugging. */
  outputTailLength?: number;
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
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SchedulerOptions) {
    this.queue = options.queue;
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.notify = options.notify ?? (() => {});
    this.outputTailLength = options.outputTailLength ?? 2000;
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
    await this.notify({
      jobId: job.id,
      project: job.project,
      event: "resumed",
      message: `Resuming job for ${job.project} (attempt ${job.attempts + 1})`,
    });

    const output = await this.runCommand(job);
    const rateLimit = parseRateLimitMessage(output);

    if (rateLimit) {
      this.queue.markWaitingForReset(job.id, rateLimit.resetAt);
      await this.notify({
        jobId: job.id,
        project: job.project,
        event: "queued",
        message: `Hit rate limit again, re-queued until ${rateLimit.resetAt}`,
      });
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

  private runCommand(job: RelayJob): Promise<string> {
    return new Promise((resolve, reject) => {
      let output = "";
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(job.command, job.cwd);
      } catch (err) {
        this.queue.markFailed(job.id, String(err));
        reject(err);
        return;
      }

      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.on("error", (err) => {
        this.queue.markFailed(job.id, String(err), output.slice(-this.outputTailLength));
        reject(err);
      });
      child.on("close", () => {
        resolve(output);
      });
    });
  }
}
