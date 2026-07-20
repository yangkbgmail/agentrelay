import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type {
  AgentRelayConfig,
  AgentTool,
  BackupResult,
  ConfigIssue,
  DiagnosticReport,
  HeartbeatFacts,
  HeartbeatMode,
  JobStatus,
  Notifier,
  PruneOptions,
  RelayJob,
  WritableFacts,
} from "@agentrelay/core";
import {
  autoPruneEveryMsFromEnv,
  autoPruneEveryTicksFromEnv,
  autoPruneOptionsFromEnv,
  CONFIG_FILENAME,
  canCancel,
  canRequeue,
  configToJson,
  countActiveJobs,
  daemonHeartbeatPath,
  distinctActiveBinaries,
  type EffectiveConfigEntry,
  type ExportFormat,
  exportJobs,
  findConfigField,
  hasConfigErrors,
  heartbeatStaleAfterMs,
  listBackups,
  loadConfigFile,
  notifiersFromEnv,
  parseConfig,
  parseDaemonHeartbeat,
  RelayQueue,
  RelayScheduler,
  type RestorePreview,
  type RestoreResult,
  resolveAdapter,
  resolveBackup,
  resolveConfigPath,
  resolveConfigWritePath,
  resolveEffectiveConfig,
  resolveJobId,
  retryPolicyFromEnv,
  runDiagnostics,
  sampleConfigJson,
  serializeDaemonHeartbeat,
  setConfigValue,
  unsetConfigValue,
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

/**
 * Write the resume-loop liveness heartbeat next to the store, atomically via a
 * temp file + rename so `doctor` never reads a half-written record. Best-effort:
 * a failed write must never break the relay loop, so it's swallowed. `startedAt`
 * is preserved across ticks by the caller; each tick just bumps `lastTickAt`.
 */
export function writeDaemonHeartbeat(
  storePath: string,
  fields: { pid: number; mode: HeartbeatMode; startedAt: string; lastTickAt: string; pollIntervalMs: number }
): void {
  const path = daemonHeartbeatPath(storePath);
  const body = serializeDaemonHeartbeat(fields);
  const tmp = `${path}.tmp-${process.pid}-${writeProbeSeq++}`;
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, body, "utf8");
    // rename is atomic on the same filesystem; readers see old-or-new, never partial.
    renameSync(tmp, path);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup; ignore
    }
  }
}

/** Remove the heartbeat file on a clean daemon shutdown. Best-effort. */
export function removeDaemonHeartbeat(storePath: string): void {
  try {
    rmSync(daemonHeartbeatPath(storePath), { force: true });
  } catch {
    // best-effort; a stale file just reads as stale and expires on its own.
  }
}

/**
 * Read and judge the heartbeat file into {@link HeartbeatFacts} for `doctor`.
 * This is the filesystem + clock half; the staleness rule and message live in
 * `@agentrelay/core`. Never throws — a missing/garbled file reads as "absent".
 */
export function readHeartbeatFacts(storePath: string, nowMs: number = Date.now()): HeartbeatFacts {
  const path = daemonHeartbeatPath(storePath);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { present: false };
  }
  const hb = parseDaemonHeartbeat(raw);
  if (!hb) return { present: false };
  const lastTick = Date.parse(hb.lastTickAt);
  if (Number.isNaN(lastTick)) return { present: false };
  return {
    present: true,
    mode: hb.mode,
    pid: hb.pid,
    ageMs: Math.max(0, nowMs - lastTick),
    staleAfterMs: heartbeatStaleAfterMs(hb.mode, hb.pollIntervalMs),
  };
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
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  const logLine = (line: string) => {
    // eslint-disable-next-line no-console
    console.log(line);
    options.onNotify?.(line);
  };
  // Liveness heartbeat: written once at startup and refreshed every tick so
  // `agentrelay doctor` can tell the resume loop is alive. startedAt is fixed
  // for this process; each tick only advances lastTickAt.
  const startedAt = new Date().toISOString();
  const beat = (at: Date) =>
    writeDaemonHeartbeat(storePath, {
      pid: process.pid,
      mode: "daemon",
      startedAt,
      lastTickAt: at.toISOString(),
      pollIntervalMs,
    });
  const scheduler = new RelayScheduler({
    queue,
    pollIntervalMs,
    retryPolicy: retryPolicyFromEnv(),
    autoPrune,
    autoPruneEveryMs,
    autoPruneEveryTicks,
    onPrune: (pruned) => logLine(`[agentrelay] auto-pruned ${pruned.length} finished job(s)`),
    onTick: (referenceTime) => beat(referenceTime),
    notify: async (payload) => {
      logLine(`[agentrelay] ${payload.event} — ${payload.project}: ${payload.message}`);
      await remoteNotify?.(payload);
    },
  });
  beat(new Date());
  scheduler.start();
  // On a clean shutdown, remove the heartbeat so `doctor` doesn't report a
  // ghost daemon (a crash leaves it, and staleness catches that instead).
  const shutdown = () => {
    scheduler.stop();
    removeDaemonHeartbeat(storePath);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // eslint-disable-next-line no-console
  console.log(
    `[agentrelay] daemon started, watching ${storePath} every ${pollIntervalMs / 1000}s` +
      (remoteNotify ? " (notifications on)" : "") +
      autoPruneBanner(autoPrune, autoPruneEveryMs, autoPruneEveryTicks)
  );
  return scheduler;
}

export async function tickOnce(storePath?: string, remoteNotify?: Notifier | null): Promise<RelayJob[]> {
  const resolvedStore = storePath ?? defaultStorePath();
  const queue = openQueue(resolvedStore);
  const notify = remoteNotify === undefined ? notifiersFromEnv() : remoteNotify;
  const scheduler = new RelayScheduler({
    queue,
    notify: notify ?? undefined,
    retryPolicy: retryPolicyFromEnv(),
    autoPrune: autoPruneOptionsFromEnv(),
  });
  const processed = await scheduler.tick();
  // Record that a (typically cron-driven) tick ran, so `doctor` can tell the
  // resume loop is being driven even without a long-lived daemon. pollIntervalMs
  // is 0 → tick mode, judged against a generous fixed staleness window.
  const at = new Date().toISOString();
  writeDaemonHeartbeat(resolvedStore, {
    pid: process.pid,
    mode: "tick",
    startedAt: at,
    lastTickAt: at,
    pollIntervalMs: 0,
  });
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

export interface ShowJobResult {
  /** True when exactly one job matched the given id/prefix. */
  ok: boolean;
  /** The resolved job (only when `ok`). */
  job: RelayJob | null;
  /** Present only when resolution failed — an explanatory message. */
  error?: string;
}

/**
 * Resolve a single job by full id or short prefix for `agentrelay show`, so
 * the CLI can print its full detail block. Reuses {@link resolveJobId} for the
 * same ambiguous/unknown handling `cancel`/`retry` give, but performs no
 * mutation — it only reads the store.
 */
export function showJob(idOrPrefix: string, storePath?: string): ShowJobResult {
  const queue = openQueue(storePath ?? defaultStorePath());
  try {
    const jobs = queue.listAll();
    const resolved = resolveJobId(jobs, idOrPrefix);
    if (resolved.error || !resolved.id) return { ok: false, job: null, error: resolved.error ?? "job not found" };
    const job = jobs.find((j) => j.id === resolved.id) ?? null;
    return { ok: true, job };
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

export interface ConfigSetOptions {
  /** Dotted config key to set (e.g. `retry.maxAttempts`). */
  key: string;
  /** Raw value as typed on the command line; coerced to the field's type. */
  value: string;
  /** Explicit target file. When omitted, resolves via {@link resolveConfigWritePath}. */
  path?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface ConfigUnsetOptions {
  key: string;
  path?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface ConfigMutateResult {
  ok: boolean;
  /** Absolute/target path that was (or would have been) written. */
  path: string;
  message: string;
}

/**
 * Reads a config file for in-place editing: returns an empty config when the
 * file is absent or blank (so a first `set` starts fresh), and throws a clear
 * error on malformed JSON or a structurally invalid file (so `set`/`unset`
 * never silently discard an existing broken config by overwriting it).
 */
function readConfigForEdit(path: string): AgentRelayConfig {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in config ${path}: ${String(error)}`);
  }
  return parseConfig(parsed, path);
}

/** Masks a secret field's value when echoing it back, so tokens don't hit scrollback. */
function echoConfigValue(key: string, value: string): string {
  const field = findConfigField(key);
  return field?.secret && value.length > 0 ? "***" : value;
}

/**
 * Sets a single value in the config file (`agentrelay config set <key> <value>`),
 * creating the file if needed. Returns a structured result instead of throwing:
 *
 * 1. resolve a definite target path (explicit → discovered → `<cwd>/…`);
 * 2. read the current file (empty when absent; error on malformed JSON);
 * 3. {@link setConfigValue} — unknown key or type-mismatched value → error;
 * 4. refuse to persist a value that fails semantic {@link validateConfig} *for
 *    that key* (e.g. `retry.factor 0.5`), so a known-bad value never lands on
 *    disk; warnings are surfaced but still written;
 * 5. write pretty JSON (matching `config init`'s formatting).
 */
export function setConfigFile(options: ConfigSetOptions): ConfigMutateResult {
  const path = resolveConfigWritePath({ path: options.path, cwd: options.cwd, env: options.env });

  let current: AgentRelayConfig;
  try {
    current = readConfigForEdit(path);
  } catch (error) {
    return { ok: false, path, message: error instanceof Error ? error.message : String(error) };
  }

  let next: AgentRelayConfig;
  try {
    next = setConfigValue(current, options.key, options.value);
  } catch (error) {
    return { ok: false, path, message: error instanceof Error ? error.message : String(error) };
  }

  // Only judge issues introduced by *this* key, so a pre-existing problem
  // elsewhere in the file doesn't block an unrelated edit.
  const issues = validateConfig(next).filter((i) => i.path === options.key);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length > 0) {
    return { ok: false, path, message: `${options.key}: ${errors.map((e) => e.message).join("; ")}` };
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, configToJson(next), "utf8");
  } catch (error) {
    return { ok: false, path, message: `Could not write config to ${path}: ${String(error)}` };
  }

  const warnings = issues.filter((i) => i.level === "warning").map((w) => w.message);
  const warnSuffix = warnings.length > 0 ? ` (warning: ${warnings.join("; ")})` : "";
  return {
    ok: true,
    path,
    message: `Set ${options.key} = ${echoConfigValue(options.key, options.value)} in ${path}${warnSuffix}`,
  };
}

/**
 * Removes a single value from the config file (`agentrelay config unset <key>`),
 * so the built-in default applies again. Returns `ok:false` when there's no file
 * to edit or the key is unknown. Emptied group objects are dropped by
 * {@link unsetConfigValue} so the file stays tidy.
 */
export function unsetConfigFile(options: ConfigUnsetOptions): ConfigMutateResult {
  const path = resolveConfigWritePath({ path: options.path, cwd: options.cwd, env: options.env });

  if (!existsSync(path)) {
    return { ok: false, path, message: `No config file at ${path} to remove "${options.key}" from.` };
  }

  let current: AgentRelayConfig;
  try {
    current = readConfigForEdit(path);
  } catch (error) {
    return { ok: false, path, message: error instanceof Error ? error.message : String(error) };
  }

  let next: AgentRelayConfig;
  try {
    next = unsetConfigValue(current, options.key);
  } catch (error) {
    return { ok: false, path, message: error instanceof Error ? error.message : String(error) };
  }

  try {
    writeFileSync(path, configToJson(next), "utf8");
  } catch (error) {
    return { ok: false, path, message: `Could not write config to ${path}: ${String(error)}` };
  }

  return { ok: true, path, message: `Removed ${options.key} from ${path} (falls back to the default).` };
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

export interface RestoreStoreOptions {
  storePath?: string;
  /**
   * Which snapshot to restore. Either a filesystem path to any snapshot file
   * (absolute or relative to cwd), or — for this store's own rotating snapshots —
   * `"latest"`, a snapshot basename, or its sortable stamp. Defaults to `"latest"`.
   */
  selector?: string;
  /** Snapshot the current store before overwriting it (default: true). */
  backupCurrent?: boolean;
}

/**
 * Resolves a restore `selector` to an absolute snapshot path. A direct path to
 * an existing file wins (lets users restore from an arbitrary snapshot they
 * point at); otherwise the selector is matched against this store's rotating
 * `.backup-*` snapshots via {@link resolveBackup}. Throws a clear error when
 * nothing matches so a typo never silently restores the wrong file.
 */
function resolveRestoreSource(storePath: string, selector: string): string {
  const asPath = resolve(process.cwd(), selector);
  if (selector !== "latest" && existsSync(asPath) && statSync(asPath).isFile()) {
    return asPath;
  }
  const dir = dirname(storePath);
  const storeName = basename(storePath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  const entry = resolveBackup(names, storeName, selector);
  if (!entry) {
    throw new Error(`No snapshot matches "${selector}" for ${storePath}. Try \`agentrelay backup --list\`.`);
  }
  return join(dir, entry.name);
}

/**
 * Restores the job store from a snapshot (the inverse of `agentrelay backup`).
 * Thin wrapper over {@link RelayQueue.restore}: it resolves the selector to a
 * snapshot path, then lets the queue validate the snapshot before overwriting
 * (and, by default, snapshot the current store first so the restore is undoable).
 */
export function restoreStore(options: RestoreStoreOptions = {}): RestoreResult {
  const storePath = options.storePath ?? defaultStorePath();
  const from = resolveRestoreSource(storePath, options.selector ?? "latest");
  const queue = openQueue(storePath);
  try {
    return queue.restore({ from, backupCurrent: options.backupCurrent });
  } finally {
    queue.close();
  }
}

/**
 * Previews a restore without touching the store — the read-only counterpart of
 * {@link restoreStore} (used by `agentrelay restore --dry-run`). Resolves the
 * selector the same way, then lets the queue validate the snapshot and report
 * what a real restore would do (source, job counts, whether it would back up).
 * A missing/broken snapshot still throws, so a dry run surfaces the same errors.
 */
export function previewRestoreStore(options: RestoreStoreOptions = {}): RestorePreview {
  const storePath = options.storePath ?? defaultStorePath();
  const from = resolveRestoreSource(storePath, options.selector ?? "latest");
  const queue = openQueue(storePath);
  try {
    return queue.previewRestore({ from, backupCurrent: options.backupCurrent });
  } finally {
    queue.close();
  }
}

export interface ExportJobsOptions {
  storePath?: string;
  /** Serialization format. */
  format: ExportFormat;
  /** Already-selected jobs to serialize (filtered/sorted by the caller). If omitted, the whole store is read. */
  jobs?: RelayJob[];
  /** When set, write the output to this file (parent dirs created) instead of returning it for stdout. */
  outPath?: string;
}

export interface ExportJobsResult {
  /** The serialized payload. Always populated, even when also written to a file. */
  content: string;
  /** Number of jobs serialized. */
  count: number;
  /** Absolute path written to, or null when the caller should print to stdout. */
  writtenTo: string | null;
}

/**
 * Serialize the job store to CSV or JSON. The heavy lifting (escaping,
 * column layout) lives in the pure `@agentrelay/core` `exportJobs`; this wrapper
 * only handles the store read and optional file write so the CLI stays thin.
 * A file write appends a trailing newline (POSIX text convention); the returned
 * `content` is the exact serializer output without it.
 */
export function exportStore(options: ExportJobsOptions): ExportJobsResult {
  const jobs = options.jobs ?? listStatus(options.storePath);
  const content = exportJobs(jobs, options.format);
  let writtenTo: string | null = null;
  if (options.outPath) {
    const path = resolve(process.cwd(), options.outPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${content}\n`, "utf8");
    writtenTo = path;
  }
  return { content, count: jobs.length, writtenTo };
}

export interface ConfigShowOptions {
  /** Explicit file path. When omitted, the usual discovery order is used. */
  path?: string;
  /** Directory searched for `agentrelay.config.json`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Environment consulted for precedence + `AGENTRELAY_CONFIG`. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface ConfigShowResult {
  /** The config file that fed the resolution, or null when none was found. */
  path: string | null;
  /** Every setting with its effective value and source (env > file > default). */
  entries: EffectiveConfigEntry[];
  /**
   * Set when a config file was found but couldn't be loaded/parsed. `show` still
   * reports env/default resolution (a broken file shouldn't blind the diagnostic
   * that would explain it) but surfaces the problem so it isn't mistaken for
   * "no file".
   */
  loadError?: string;
}

/**
 * Resolves the *effective* configuration — what value each setting actually
 * takes and where it comes from — so users can debug the env > file > default
 * precedence without guessing. Unlike `config validate`, a malformed file is
 * non-fatal here: env/default entries are still reported and the load error is
 * returned alongside them. Never throws.
 */
export function showConfig(options: ConfigShowOptions = {}): ConfigShowResult {
  const env = options.env ?? process.env;
  let fileConfig: AgentRelayConfig | null = null;
  let path: string | null = null;
  let loadError: string | undefined;
  try {
    const loaded = loadConfigFile({ path: options.path, cwd: options.cwd, env });
    if (loaded) {
      fileConfig = loaded.config;
      path = loaded.path;
    }
  } catch (error) {
    // Report where the broken file lives (if resolvable) but keep going.
    path = resolveConfigPath({ path: options.path, cwd: options.cwd, env });
    loadError = String(error);
  }
  const entries = resolveEffectiveConfig(fileConfig, env);
  return { path, entries, loadError };
}

export interface DoctorOptions {
  storePath?: string;
  /** Explicit config path. When omitted, the usual discovery order is used. */
  configPath?: string;
  /** Directory searched for `agentrelay.config.json`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Environment consulted for notify channels + `AGENTRELAY_CONFIG`. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Running Node version. Defaults to `process.version`. Injectable for tests. */
  nodeVersion?: string;
  /** "Now" (epoch ms) used to age the heartbeat. Defaults to `Date.now()`. Injectable for tests. */
  nowMs?: number;
}

/** True when `p` is an existing, executable file. Errors (missing/perms) → false. */
function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `which`-style lookup: resolves a bare binary name against PATH (honoring
 * PATHEXT on Windows), or checks a path-qualified name directly. Returns the
 * absolute path it resolved to, or null when nothing executable was found.
 * Pure enough to keep the doctor's PATH probing in one place.
 */
function resolveOnPath(binary: string, env: Record<string, string | undefined>): string | null {
  if (binary.includes("/") || binary.includes("\\")) {
    const direct = resolve(binary);
    return isExecutableFile(direct) ? direct : null;
  }
  const pathVar = env.PATH ?? env.Path ?? "";
  if (!pathVar) return null;
  const isWin = process.platform === "win32";
  const exts = isWin ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)] : [""];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, binary + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Module counter so back-to-back write probes never collide on a filename. */
let writeProbeSeq = 0;

/**
 * Walks up from `dir` to the nearest ancestor that actually exists on disk
 * (possibly `dir` itself). Returns null only if even the filesystem root is
 * missing, which shouldn't happen. Used so the write probe can test a
 * not-yet-created store dir by checking the parent the queue will mkdir into.
 */
function nearestExistingDir(dir: string): string | null {
  let current = dir;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

/**
 * Probes whether the store directory can actually be written to by creating and
 * removing a throwaway file — the honest test of "can the relay persist state",
 * catching read-only mounts and full disks that a bare permission-bit check
 * would miss. When the store dir doesn't exist yet (fresh install), probes the
 * nearest existing ancestor since the queue mkdir's the dir on first flush.
 * Never throws — a failed probe is exactly what we want to report.
 */
function probeStoreWritable(storePath: string): WritableFacts {
  const dir = dirname(storePath);
  const willCreate = !existsSync(dir);
  const target = nearestExistingDir(dir);
  if (!target) {
    return { dir, writable: false, willCreate, error: "no existing parent directory" };
  }
  writeProbeSeq += 1;
  const probe = join(target, `.agentrelay-write-probe-${process.pid}-${writeProbeSeq}`);
  try {
    writeFileSync(probe, "", { flag: "wx" });
    rmSync(probe, { force: true });
    return { dir, writable: true, willCreate };
  } catch (error) {
    try {
      rmSync(probe, { force: true });
    } catch {
      // best-effort cleanup; ignore
    }
    return { dir, writable: false, willCreate, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Gathers real environment/store/config facts and runs them through the pure
 * {@link runDiagnostics} judge for `agentrelay doctor`. This is the filesystem +
 * env half; every actual health rule lives in `@agentrelay/core` so it can be
 * unit-tested without disk. Never throws — a broken config becomes a reported
 * error check rather than a crash, which is the whole point of a doctor command.
 */
export function runDoctor(options: DoctorOptions = {}): DiagnosticReport {
  const env = options.env ?? process.env;

  // --- store facts. Capture existence *before* opening the queue, because a
  // corrupt file gets moved aside during load and would then look "absent".
  const storePath = options.storePath ?? defaultStorePath();
  const existedBefore = existsSync(storePath);

  // --- writability facts. The store loader only reads; every state change has
  // to write the file back, so a non-writable store dir loses every update
  // silently. Probe with a real throwaway write *before* opening the queue,
  // because RelayQueue's constructor mkdir's the store dir (which would make a
  // not-yet-created dir look already-present).
  const writable = probeStoreWritable(storePath);

  let corrupt = false;
  let jobs: RelayJob[] = [];
  try {
    const queue = new RelayQueue(storePath, { onCorrupt: () => (corrupt = true) });
    jobs = queue.listAll();
    queue.close();
  } catch {
    // Opening the queue can throw when the store dir can't be created/written
    // (parent is a file, perms deny mkdir, read-only mount). The writable probe
    // above already captured that as an error check, so swallow the crash and
    // let `doctor` report the diagnosis instead of a stack trace.
  }

  // --- config facts. A missing file is fine (env/defaults); a present-but-broken
  // file is a load error; an OK file is run through the semantic validator.
  let configPathResolved: string | null = null;
  let loadError: string | null = null;
  let issues: ConfigIssue[] = [];
  try {
    const loaded = loadConfigFile({ path: options.configPath, cwd: options.cwd, env });
    if (loaded) {
      configPathResolved = loaded.path;
      issues = validateConfig(loaded.config);
    }
  } catch (error) {
    configPathResolved = resolveConfigPath({ path: options.configPath, cwd: options.cwd, env });
    loadError = String(error);
  }

  // --- adapter facts. The relay re-spawns each active job's `command[0]`; if
  // that binary isn't on PATH, the resume fails silently. Probe each distinct
  // one so `doctor` catches "the tool isn't installed" before a resume does.
  const binaries = distinctActiveBinaries(jobs).map(({ binary, neededBy }) => {
    const resolvedPath = resolveOnPath(binary, env);
    return { binary, neededBy, found: resolvedPath !== null, resolvedPath: resolvedPath ?? undefined };
  });

  return runDiagnostics({
    nodeVersion: options.nodeVersion ?? process.version,
    store: {
      path: storePath,
      exists: existedBefore,
      corrupt,
      jobCount: jobs.length,
      activeCount: countActiveJobs(jobs),
    },
    writable,
    config: { path: configPathResolved, loadError, issues },
    notify: {
      slackWebhook: env.AGENTRELAY_SLACK_WEBHOOK,
      webhookUrl: env.AGENTRELAY_WEBHOOK_URL,
    },
    adapters: { binaries },
    // --- heartbeat facts. Reads the liveness file the daemon/tick writes so
    // doctor can flag "jobs waiting but nothing running to resume them".
    heartbeat: readHeartbeatFacts(storePath, options.nowMs),
  });
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
