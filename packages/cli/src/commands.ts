import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type {
  AgentRelayConfig,
  AgentTool,
  BackupResult,
  ConfigIssue,
  JobStatus,
  Notifier,
  PruneOptions,
  RelayJob,
} from "@agentrelay/core";
import {
  autoPruneEveryMsFromEnv,
  autoPruneEveryTicksFromEnv,
  autoPruneOptionsFromEnv,
  CONFIG_FILENAME,
  canCancel,
  canRequeue,
  hasConfigErrors,
  listBackups,
  notifiersFromEnv,
  parseConfig,
  RelayQueue,
  RelayScheduler,
  resolveAdapter,
  resolveConfigPath,
  resolveJobId,
  retryPolicyFromEnv,
  sampleConfigJson,
  validateConfig,
} from "@agentrelay/core";
import { defaultStorePath, resolveProjectName } from "./config.js";

/**
 * Constructs a {@link RelayQueue} that, if the store file turns out to be
 * corrupt, moves the unreadable file aside and warns on stderr instead of
 * silently discarding it. Every CLI command opens the store through this so the
 * user always learns when their queue file couldn't be read.
 */
function openQueue(storePath: string): RelayQueue {
  return new RelayQueue(storePath, {
    onCorrupt: ({ path, backupPath }) => {
      const where = backupPath ? `moved it aside to ${backupPath}` : "could not move it aside";
      // eslint-disable-next-line no-console
      console.error(
        `[agentrelay] warning: store file ${path} was unreadable; ${where} and started with an empty queue.`
      );
    },
  });
}

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

  const queue = openQueue(storePath);
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
  const queue = openQueue(storePath);
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
  const queue = openQueue(storePath ?? defaultStorePath());
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
  const queue = openQueue(storePath ?? defaultStorePath());
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
  const queue = openQueue(storePath ?? defaultStorePath());
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
  const queue = openQueue(storePath ?? defaultStorePath());
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
  const queue = openQueue(storePath ?? defaultStorePath());
  const pruned = queue.prune(pruneOpts);
  // On a dry run nothing was deleted, so subtract the would-be-pruned count to
  // report the count that *would* remain (matches the non-dry-run number).
  const remaining = queue.listAll().length - (pruneOpts.dryRun ? pruned.length : 0);
  queue.close();
  return { pruned, remaining };
}

export interface ConfigInitOptions {
  /** Target file path. Defaults to `<cwd>/agentrelay.config.json`. */
  path?: string;
  /** Directory the default path is resolved against. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Overwrite an existing file instead of refusing. */
  force?: boolean;
}

export interface ConfigInitResult {
  ok: boolean;
  /** Absolute path that was (or would have been) written. */
  path: string;
  message: string;
}

/**
 * Writes a fully-populated sample `agentrelay.config.json` so users have a
 * documented starting point instead of hand-authoring one. Refuses to clobber
 * an existing file unless `force` is set (returns `ok:false` so the CLI can
 * exit non-zero). Creates parent directories as needed. The written content
 * round-trips through `parseConfig`, so `agentrelay --config <path> status`
 * works immediately.
 */
export function initConfig(options: ConfigInitOptions = {}): ConfigInitResult {
  const cwd = options.cwd ?? process.cwd();
  // A supplied relative path resolves against cwd; an absolute one wins; no
  // path at all defaults to the discovery filename in cwd.
  const path = resolve(cwd, options.path?.trim() || CONFIG_FILENAME);

  if (existsSync(path) && !options.force) {
    return {
      ok: false,
      path,
      message: `Config already exists at ${path}. Re-run with --force to overwrite.`,
    };
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, sampleConfigJson(), "utf8");
  } catch (error) {
    return { ok: false, path, message: `Could not write config to ${path}: ${String(error)}` };
  }

  const verb = options.force ? "Overwrote" : "Wrote";
  return { ok: true, path, message: `${verb} sample config to ${path}. Edit it, then run any command.` };
}

export interface ConfigValidateOptions {
  /** Explicit file path. When omitted, the usual discovery order is used. */
  path?: string;
  /** Directory searched for `agentrelay.config.json`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Environment consulted for `AGENTRELAY_CONFIG`. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface ConfigValidateResult {
  /** True when the file was found, parsed, and has no error-level issues. */
  ok: boolean;
  /** The file that was checked, or null when discovery found nothing. */
  path: string | null;
  issues: ConfigIssue[];
}

/**
 * Validates a config file end to end and returns a structured result instead of
 * throwing, so the `config validate` command can report every problem at once:
 *
 * 1. resolve which file to check (explicit path or the normal discovery order);
 * 2. read + `JSON.parse` it — an unreadable file or bad JSON becomes one error
 *    issue rather than a crash;
 * 3. `parseConfig` for structural (type) mistakes — reported as an error;
 * 4. {@link validateConfig} for semantic mistakes (bad durations, negative
 *    numbers, non-URL webhooks) — errors and warnings.
 *
 * `ok` is true only when a file was found, parsed, and produced no error-level
 * issues (warnings still pass), so the CLI can exit non-zero on real problems.
 */
export function validateConfigFile(options: ConfigValidateOptions = {}): ConfigValidateResult {
  const path = resolveConfigPath({ path: options.path, cwd: options.cwd, env: options.env });
  if (!path) {
    return {
      ok: false,
      path: null,
      issues: [
        {
          level: "error",
          path: "file",
          message: "no config file found (looked for ./agentrelay.config.json and ~/.agentrelay/config.json)",
        },
      ],
    };
  }

  if (!existsSync(path)) {
    return { ok: false, path, issues: [{ level: "error", path: "file", message: `not found: ${path}` }] };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { ok: false, path, issues: [{ level: "error", path: "file", message: `could not read: ${String(error)}` }] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, path, issues: [{ level: "error", path: "file", message: `invalid JSON: ${String(error)}` }] };
  }

  let config: AgentRelayConfig;
  try {
    config = parseConfig(parsed, "config");
  } catch (error) {
    // parseConfig throws a message already scoped like "config.retry.factor must be…".
    return { ok: false, path, issues: [{ level: "error", path: "structure", message: String(error) }] };
  }

  const issues = validateConfig(config);
  return { ok: !hasConfigErrors(issues), path, issues };
}

export interface BackupStoreOptions {
  storePath?: string;
  /** How many recent snapshots to retain (default: core's DEFAULT_BACKUP_KEEP). */
  keepLast?: number;
}

/**
 * Writes a timestamped snapshot of the job store and rotates old snapshots.
 * Thin wrapper over {@link RelayQueue.backup} that owns opening/closing the
 * store, so the CLI (and tests) get a one-call entry point.
 */
export function backupStore(options: BackupStoreOptions = {}): BackupResult {
  const queue = openQueue(options.storePath ?? defaultStorePath());
  try {
    return queue.backup({ keepLast: options.keepLast });
  } finally {
    queue.close();
  }
}

export interface StoreBackupInfo {
  /** Absolute path of the snapshot. */
  path: string;
  /** The snapshot's sortable timestamp infix (see core `backupStamp`). */
  stamp: string;
}

/**
 * Lists the store's existing snapshots (newest first) by scanning the store's
 * directory for `<store>.backup-*` files. Reads no snapshot contents — just
 * enumerates them for `agentrelay backup --list`. A missing/unreadable
 * directory yields an empty list rather than throwing.
 */
export function listStoreBackups(storePath?: string): StoreBackupInfo[] {
  const store = storePath ?? defaultStorePath();
  const dir = dirname(store);
  const storeName = basename(store);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return listBackups(names, storeName).map((entry) => ({ path: join(dir, entry.name), stamp: entry.stamp }));
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
