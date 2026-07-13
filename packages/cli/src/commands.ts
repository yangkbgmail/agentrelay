import { spawn } from "node:child_process";
import { RelayQueue, RelayScheduler, parseRateLimitMessage, slackNotifierFromEnv } from "@agentrelay/core";
import type { AgentTool, Notifier, RelayJob, RetryPolicy } from "@agentrelay/core";
import { defaultStorePath, resolveProjectName } from "./config.js";

/**
 * Reads retry-policy overrides from the environment so operators can tune the
 * daemon without code changes. Each var is optional; unset/invalid values fall
 * back to DEFAULT_RETRY_POLICY inside the scheduler.
 *   AGENTRELAY_MAX_ATTEMPTS    — cap on total resume attempts per job
 *   AGENTRELAY_BASE_BACKOFF_MS — base delay for transient-failure backoff
 *   AGENTRELAY_MAX_BACKOFF_MS  — upper bound on any single backoff delay
 */
export function retryPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<RetryPolicy> {
  const policy: Partial<RetryPolicy> = {};
  const num = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const maxAttempts = num(env.AGENTRELAY_MAX_ATTEMPTS);
  const baseBackoffMs = num(env.AGENTRELAY_BASE_BACKOFF_MS);
  const maxBackoffMs = num(env.AGENTRELAY_MAX_BACKOFF_MS);
  if (maxAttempts !== undefined) policy.maxAttempts = maxAttempts;
  if (baseBackoffMs !== undefined) policy.baseBackoffMs = baseBackoffMs;
  if (maxBackoffMs !== undefined) policy.maxBackoffMs = maxBackoffMs;
  return policy;
}

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
  /** Retry/backoff overrides; defaults to values from the environment. */
  retryPolicy?: Partial<RetryPolicy>;
}

export function startDaemon(options: DaemonOptions = {}) {
  const storePath = options.storePath ?? defaultStorePath();
  const queue = new RelayQueue(storePath);
  const slackNotify = options.slackNotify === undefined ? slackNotifierFromEnv() : options.slackNotify;
  const scheduler = new RelayScheduler({
    queue,
    pollIntervalMs: options.pollIntervalMs ?? 30_000,
    retryPolicy: options.retryPolicy ?? retryPolicyFromEnv(),
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
  const scheduler = new RelayScheduler({
    queue,
    notify: notify ?? undefined,
    retryPolicy: retryPolicyFromEnv(),
  });
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
