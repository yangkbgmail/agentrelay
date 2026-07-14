import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentTool, DoctorInput, JobStatus, Notifier, PruneOptions, RelayJob } from "@agentrelay/core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentTool, JobStatus, Notifier, PruneOptions, RelayJob } from "@agentrelay/core";
import {
  autoPruneEveryMsFromEnv,
  autoPruneEveryTicksFromEnv,
  autoPruneOptionsFromEnv,
  canCancel,
  canRequeue,
  loadConfigFile,
  notifiersFromEnv,
  RelayQueue,
  RelayScheduler,
  resolveAdapter,
  resolveConfigPath,
  resolveJobId,
  retryPolicyFromEnv,
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

/**
 * Probes whether the relay could write the store file: if it already exists,
 * the file itself must be writable; otherwise the nearest existing ancestor
 * directory must be writable (the queue creates missing dirs on first run).
 * Never creates anything — a pure read-only probe for `agentrelay doctor`.
 */
function isStoreWritable(storePath: string, exists: boolean): boolean {
  try {
    if (exists) {
      accessSync(storePath, constants.W_OK);
      return true;
    }
    let dir = dirname(storePath);
    while (!existsSync(dir)) {
      const parent = dirname(dir);
      if (parent === dir) break; // reached the filesystem root
      dir = parent;
    }
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gathers the real environment snapshot for `agentrelay doctor` — reading the
 * Node version, probing the store file, discovering the config, and inspecting
 * the effective notifiers/retry policy from env. All the actual I/O lives here;
 * the verdict logic is the pure `runDoctorChecks` in core.
 */
export function gatherDoctorInput(storePath?: string, configPath?: string): DoctorInput {
  const path = storePath ?? defaultStorePath();
  const exists = existsSync(path);

  let jobCount: number | null = null;
  let parseError: string | null = null;
  if (exists) {
    try {
      const raw = readFileSync(path, "utf8");
      if (raw.trim() === "") {
        jobCount = 0;
      } else {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          jobCount = parsed.length;
        } else {
          parseError = "expected a JSON array of jobs";
        }
      }
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }

  // Honor an explicit `--config <path>` (the same one bin.ts bootstrapped from)
  // so the doctor reports the file the CLI actually used, not just discovery.
  let resolvedConfigPath: string | null = null;
  let configError: string | null = null;
  try {
    resolvedConfigPath = loadConfigFile({ path: configPath })?.path ?? null;
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
    // Still surface which path was being attempted, if we can resolve it.
    try {
      resolvedConfigPath = resolveConfigPath({ path: configPath });
    } catch {
      resolvedConfigPath = null;
    }
  }

  return {
    nodeVersion: process.versions.node,
    store: { path, exists, writable: isStoreWritable(path, exists), jobCount, parseError },
    config: { path: resolvedConfigPath, error: configError },
    notifiers: {
      slack: Boolean(process.env.AGENTRELAY_SLACK_WEBHOOK?.trim()),
      webhook: Boolean(process.env.AGENTRELAY_WEBHOOK_URL?.trim()),
    },
    retry: retryPolicyFromEnv(),
  };
 * Writes exported text to a file, creating parent directories as needed. Kept
 * here (not in cli.ts) so the file-writing side effect stays out of the pure
 * render layer. Returns the resolved path for the CLI to report.
 */
export function writeExportFile(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
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
