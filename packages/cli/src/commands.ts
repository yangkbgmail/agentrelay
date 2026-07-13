import { spawn } from "node:child_process";
import { RelayQueue, RelayScheduler, parseRateLimitMessage, slackNotifierFromEnv } from "@agentrelay/core";
import type { AgentTool, Notifier, RelayJob, RetryPolicy } from "@agentrelay/core";
import { defaultStorePath, resolveProjectName } from "./config.js";

export interface RunOptions {
  command: string[];
  cwd?: string;
  tool?: AgentTool;
  storePath?: string;
  /** Injected for tests; defaults to real stdout/stderr passthrough. */
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** Injected for tests; defaults to Slack via AGENTRELAY_SLACK_WEBHOOK (or silent skip). */
  notify?: Notifier | null;
}

export interface RunResult {
  exitCode: number;
  queuedJob: RelayJob | null;
}

/**
 * Runs `command`, streaming its output live while also buffering it to scan
 * for a rate-limit message. If one is found, the command is enqueued for
 * automatic resume once the limit resets -- this is the core "wrap your
 * agent CLI invocation" entry point (`agentrelay run -- claude -p "..."`).
 */
export async function runCommand(options: RunOptions): Promise<RunResult> {
  const cwd = options.cwd ?? process.cwd();
  const tool = options.tool ?? "claude-code";
  const storePath = options.storePath ?? defaultStorePath();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const [exitCode, output] = await new Promise<[number, string]>((resolve) => {
    let buffered = "";
    const [cmd, ...args] = options.command;
    const child = spawn(cmd, args, { cwd, stdio: ["inherit", "pipe", "pipe"] });

    child.stdout.on("data", (chunk) => {
      stdout.write(chunk);
      buffered += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr.write(chunk);
      buffered += chunk.toString();
    });
    child.on("close", (code) => resolve([code ?? 0, buffered]));
    child.on("error", (err) => {
      buffered += `\n${String(err)}`;
      resolve([1, buffered]);
    });
  });

  const rateLimit = parseRateLimitMessage(output);
  if (!rateLimit) {
    return { exitCode, queuedJob: null };
  }

  const queue = new RelayQueue(storePath);
  const project = resolveProjectName(cwd);
  const job = queue.enqueue({ project, tool, command: options.command, cwd });
  queue.markWaitingForReset(job.id, rateLimit.resetAt);
  queue.close();

  stdout.write(
    `\n[agentrelay] Rate limit detected (pattern: ${rateLimit.pattern}). Queued job ${job.id} to resume at ${rateLimit.resetAt}.\n` +
      `Run "agentrelay daemon" (or schedule "agentrelay tick" via cron) to auto-resume it.\n`
  );

  const notify = options.notify === undefined ? slackNotifierFromEnv() : options.notify;
  await notify?.({
    jobId: job.id,
    project,
    event: "queued",
    message: `Rate limit detected, queued to resume at ${rateLimit.resetAt}`,
  });

  return { exitCode, queuedJob: queue.getById(job.id) ?? null };
}

export interface DaemonOptions {
  storePath?: string;
  pollIntervalMs?: number;
  onNotify?: (message: string) => void;
  /** Injected for tests; defaults to Slack via AGENTRELAY_SLACK_WEBHOOK (or silent skip). */
  slackNotify?: Notifier | null;
  /** Retry policy for transient (non-rate-limit) failures; see RelayScheduler. */
  retry?: Partial<RetryPolicy> | false;
}

export function startDaemon(options: DaemonOptions = {}) {
  const storePath = options.storePath ?? defaultStorePath();
  const queue = new RelayQueue(storePath);
  const slackNotify = options.slackNotify === undefined ? slackNotifierFromEnv() : options.slackNotify;
  const scheduler = new RelayScheduler({
    queue,
    pollIntervalMs: options.pollIntervalMs ?? 30_000,
    retry: options.retry,
    notify: async (payload) => {
      const line = `[agentrelay] ${payload.event} — ${payload.project}: ${payload.message}`;
      // eslint-disable-next-line no-console
      console.log(line);
      options.onNotify?.(line);
      await slackNotify?.(payload);
    },
  });
  scheduler.start();
  // eslint-disable-next-line no-console
  console.log(
    `[agentrelay] daemon started, watching ${storePath} every ${(options.pollIntervalMs ?? 30_000) / 1000}s` +
      (slackNotify ? " (Slack notifications on)" : "")
  );
  return scheduler;
}

export async function tickOnce(storePath?: string, slackNotify?: Notifier | null): Promise<RelayJob[]> {
  const queue = new RelayQueue(storePath ?? defaultStorePath());
  const notify = slackNotify === undefined ? slackNotifierFromEnv() : slackNotify;
  const scheduler = new RelayScheduler({ queue, notify: notify ?? undefined });
  const processed = await scheduler.tick();
  queue.close();
  return processed;
}

export function listStatus(storePath?: string): RelayJob[] {
  const queue = new RelayQueue(storePath ?? defaultStorePath());
  const jobs = queue.listAll();
  queue.close();
  return jobs;
}
