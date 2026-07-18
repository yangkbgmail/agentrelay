import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AgentTool, JobStatus, Notifier, PruneOptions, RelayJob } from "@agentrelay/core";
import {
  autoPruneEveryMsFromEnv,
  autoPruneEveryTicksFromEnv,
  autoPruneOptionsFromEnv,
  buildSampleConfig,
  CONFIG_FILENAME,
  canCancel,
  canRequeue,
  notifiersFromEnv,
  RelayQueue,
  RelayScheduler,
  resolveAdapter,
  resolveJobId,
  retryPolicyFromEnv,
  serializeConfig,
} from "@agentrelay/core";
import { defaultStorePath, resolveProjectName } from "./config.js";

export interface RunOptions {
  command: string[];
  cwd?: string;
  tool?: AgentTool;
  storePath?: string;
  /** Injected for tests; defaults to real stdout/stderr passthrough. */
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /**
   * Injected for tests; defaults to the env-configured notifiers
   * (AGENTRELAY_SLACK_WEBHOOK and/or AGENTRELAY_WEBHOOK_URL, or silent skip).
   */
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
  // Pick the adapter from an explicit --tool, else infer from the command's
  // binary (e.g. `codex ...` -> codex-cli), else fall back to the generic one.
  const adapter = resolveAdapter({ tool: options.tool, command: options.command });
  const tool = adapter.tool;
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

  const rateLimit = adapter.detectRateLimit(output);
  if (!rateLimit) {
    return { exitCode, queuedJob: null };
  }

  const queue = new RelayQueue(storePath);
  const project = resolveProjectName(cwd);
  const job = queue.enqueue({ project, tool, command: options.command, cwd });
  queue.markWaitingForReset(job.id, rateLimit.resetAt);
  queue.close();

  stdout.write(
    `\n[agentrelay] Rate limit detected for ${adapter.displayName} (pattern: ${rateLimit.pattern}). Queued job ${job.id} to resume at ${rateLimit.resetAt}.\n` +
      `Run "agentrelay daemon" (or schedule "agentrelay tick" via cron) to auto-resume it.\n`
  );

  const notify = options.notify === undefined ? notifiersFromEnv() : options.notify;
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
  /**
   * Injected for tests; defaults to the env-configured notifiers
   * (AGENTRELAY_SLACK_WEBHOOK and/or AGENTRELAY_WEBHOOK_URL, or silent skip).
   */
  remoteNotify?: Notifier | null;
}

/** Human-readable "(auto-prune on, ...)" suffix for the daemon startup banner. */
function autoPruneBanner(
  autoPrune: PruneOptions | null,
  everyMs: number | undefined,
  everyTicks: number | undefined
): string {
  if (!autoPrune) return "";
  const parts: string[] = [];
  if (everyMs) parts.push(`every ${Math.round(everyMs / 1000)}s`);
  if (everyTicks) parts.push(`every ${everyTicks} tick(s)`);
  return parts.length ? ` (auto-prune on, ${parts.join(" + ")})` : " (auto-prune on)";
}

export function startDaemon(options: DaemonOptions = {}) {
  const storePath = options.storePath ?? defaultStorePath();
  const queue = new RelayQueue(storePath);
  const remoteNotify = options.remoteNotify === undefined ? notifiersFromEnv() : options.remoteNotify;
  const autoPrune = autoPruneOptionsFromEnv();
  const autoPruneEveryMs = autoPruneEveryMsFromEnv() ?? undefined;
  const autoPruneEveryTicks = autoPruneEveryTicksFromEnv() ?? undefined;
  const logLine = (line: string) => {
    // eslint-disable-next-line no-console
    console.log(line);
    options.onNotify?.(line);
  };
  const scheduler = new RelayScheduler({
    queue,
    pollIntervalMs: options.pollIntervalMs ?? 30_000,
    retryPolicy: retryPolicyFromEnv(),
    autoPrune,
    autoPruneEveryMs,
    autoPruneEveryTicks,
    onPrune: (pruned) => logLine(`[agentrelay] auto-pruned ${pruned.length} finished job(s)`),
    notify: async (payload) => {
      logLine(`[agentrelay] ${payload.event} — ${payload.project}: ${payload.message}`);
      await remoteNotify?.(payload);
    },
  });
  scheduler.start();
  // eslint-disable-next-line no-console
  console.log(
    `[agentrelay] daemon started, watching ${storePath} every ${(options.pollIntervalMs ?? 30_000) / 1000}s` +
      (remoteNotify ? " (notifications on)" : "") +
      autoPruneBanner(autoPrune, autoPruneEveryMs, autoPruneEveryTicks)
  );
  return scheduler;
}

export async function tickOnce(storePath?: string, remoteNotify?: Notifier | null): Promise<RelayJob[]> {
  const queue = new RelayQueue(storePath ?? defaultStorePath());
  const notify = remoteNotify === undefined ? notifiersFromEnv() : remoteNotify;
  const scheduler = new RelayScheduler({
    queue,
    notify: notify ?? undefined,
    retryPolicy: retryPolicyFromEnv(),
    autoPrune: autoPruneOptionsFromEnv(),
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

export interface JobControlResult {
  ok: boolean;
  /** The job after the transition (only when `ok`). */
  job: RelayJob | null;
  /** Human-readable line for the CLI to print. */
  message: string;
}

const shortId = (id: string) => id.slice(0, 8);

/**
 * Cancel a pending job by full id or short prefix. Terminal jobs are rejected
 * with an explanatory message rather than silently doing nothing.
 */
export function cancelJob(idOrPrefix: string, storePath?: string): JobControlResult {
  const queue = new RelayQueue(storePath ?? defaultStorePath());
  try {
    const jobs = queue.listAll();
    const resolved = resolveJobId(jobs, idOrPrefix);
    if (resolved.error || !resolved.id) return { ok: false, job: null, message: resolved.error ?? "job not found" };

    const job = jobs.find((j) => j.id === resolved.id) as RelayJob;
    const guard = canCancel(job);
    if (!guard.ok) return { ok: false, job, message: `cannot cancel ${shortId(job.id)}: ${guard.reason}` };

    queue.markCancelled(job.id);
    const updated = queue.getById(job.id) ?? null;
    return { ok: true, job: updated, message: `cancelled job ${shortId(job.id)} (${job.project})` };
  } finally {
    queue.close();
  }
}

/**
 * Requeue a job to resume immediately by full id or short prefix. In-flight
 * (`resuming`) jobs are rejected to avoid racing the running command.
 */
export function retryJob(idOrPrefix: string, storePath?: string): JobControlResult {
  const queue = new RelayQueue(storePath ?? defaultStorePath());
  try {
    const jobs = queue.listAll();
    const resolved = resolveJobId(jobs, idOrPrefix);
    if (resolved.error || !resolved.id) return { ok: false, job: null, message: resolved.error ?? "job not found" };

    const job = jobs.find((j) => j.id === resolved.id) as RelayJob;
    const guard = canRequeue(job);
    if (!guard.ok) return { ok: false, job, message: `cannot retry ${shortId(job.id)}: ${guard.reason}` };

    queue.requeueNow(job.id);
    const updated = queue.getById(job.id) ?? null;
    return {
      ok: true,
      job: updated,
      message: `job ${shortId(job.id)} (${job.project}) queued to resume now — run "agentrelay tick" or the daemon to pick it up`,
    };
  } finally {
    queue.close();
  }
}

export interface PruneJobsOptions extends PruneOptions {
  storePath?: string;
  dryRun?: boolean;
}

/**
 * Removes old finished jobs from the store (or, with `dryRun`, reports what
 * would be removed without touching the file). Returns the affected jobs plus
 * the remaining count so the CLI can print a summary.
 */
export function pruneJobs(options: PruneJobsOptions = {}): { pruned: RelayJob[]; remaining: number } {
  const { storePath, ...pruneOpts } = options;
  const queue = new RelayQueue(storePath ?? defaultStorePath());
  const pruned = queue.prune(pruneOpts);
  // On a dry run nothing was deleted, so subtract the would-be-pruned count to
  // report the count that *would* remain (matches the non-dry-run number).
  const remaining = queue.listAll().length - (pruneOpts.dryRun ? pruned.length : 0);
  queue.close();
  return { pruned, remaining };
}

export interface InitConfigOptions {
  /** Where to write the file. Relative paths resolve against `cwd`. */
  path?: string;
  /** Overwrite an existing file instead of refusing. */
  force?: boolean;
  /** Store path to bake into the template (defaults to the resolved store). */
  storePath?: string;
  /** Base directory for relative paths and the default filename. Defaults to `process.cwd()`. */
  cwd?: string;
}

export interface InitConfigResult {
  ok: boolean;
  /** Absolute path that was written (or that already existed). */
  path: string;
  message: string;
}

/**
 * Writes a starter `agentrelay.config.json` populated with every option at its
 * built-in default, so users can edit instead of memorizing `AGENTRELAY_*` env
 * vars. Refuses to clobber an existing file unless `force` is set — an existing
 * config likely holds real settings. Creates parent directories as needed
 * (e.g. `~/.agentrelay/config.json`).
 */
export function initConfig(options: InitConfigOptions = {}): InitConfigResult {
  const cwd = options.cwd ?? process.cwd();
  const requested = options.path?.trim() || CONFIG_FILENAME;
  const target = isAbsolute(requested) ? requested : resolve(cwd, requested);

  if (existsSync(target) && !options.force) {
    return {
      ok: false,
      path: target,
      message: `Config already exists: ${target}. Re-run with --force to overwrite.`,
    };
  }

  const sample = buildSampleConfig(options.storePath ?? defaultStorePath());
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, serializeConfig(sample), "utf8");

  return { ok: true, path: target, message: `Wrote starter config to ${target}` };
}

/** Statuses a job can legitimately be in — used to validate `--status` input. */
export const ALL_JOB_STATUSES: JobStatus[] = [
  "queued",
  "waiting_for_reset",
  "resuming",
  "completed",
  "failed",
  "cancelled",
];
