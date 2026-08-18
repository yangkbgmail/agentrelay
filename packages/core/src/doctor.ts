import type { ConfigIssue } from "./config.js";
import type { HeartbeatMode } from "./heartbeat.js";
import { isPlausibleReset } from "./parser.js";
import type { RelayJob } from "./types.js";

/**
 * Health-check diagnostics for `agentrelay doctor`.
 *
 * The point of a local-first CLI is that "it just works" on the user's own
 * machine — but a mis-set env var, an unsupported Node, or a store file that got
 * corrupted can silently break the relay loop. `doctor` gathers the facts that
 * matter and reports them as a flat list of pass/warn/fail checks so a user can
 * confirm their setup in one command instead of guessing.
 *
 * The gathering (reading the store, resolving the config file, inspecting the
 * environment) lives in the CLI where the filesystem is; this module is the
 * *pure* judgement layer — it takes already-collected facts and decides what's
 * healthy. That keeps every rule unit-testable without touching disk or env.
 */

/** Severity of a single {@link DiagnosticCheck}. Errors fail the report. */
export type DiagnosticLevel = "ok" | "warning" | "error";

/** One thing `doctor` looked at, with a verdict and (for problems) a fix hint. */
export interface DiagnosticCheck {
  /** Stable short id, e.g. `node-version` — usable as a machine key. */
  name: string;
  level: DiagnosticLevel;
  /** Human-readable one-liner describing what was found. */
  message: string;
  /** Actionable suggestion, shown for warnings/errors. */
  hint?: string;
}

/** The full result of {@link runDiagnostics}. */
export interface DiagnosticReport {
  checks: DiagnosticCheck[];
  /** True when no check is at `error` level (warnings still pass). */
  ok: boolean;
  /** Count of checks at each level, for a one-line summary. */
  counts: Record<DiagnosticLevel, number>;
}

/** Facts about the job store, gathered by the CLI before judging. */
export interface StoreFacts {
  /** Resolved store path (`~` already expanded). */
  path: string;
  /** Whether the file exists on disk. */
  exists: boolean;
  /**
   * True when the file existed but couldn't be parsed as a valid job array —
   * the store loader moves it aside, so this is a real "your data was bad" flag.
   */
  corrupt: boolean;
  /** Jobs currently in the store (0 when absent/corrupt). */
  jobCount: number;
  /** Jobs in a non-terminal state (queued/waiting_for_reset/resuming). */
  activeCount: number;
}

/**
 * Facts about whether the store *directory* can be written to, gathered by the
 * CLI (which does the actual probe write) before judging. The store loader
 * happily reads a file, but every `flush()` has to *write* it back — if the
 * directory isn't writable the relay silently loses every state change (a job
 * marked `resuming` never persists, so it re-runs or is lost on restart). This
 * is the #2 "resume fails quietly" failure mode after a missing PATH binary.
 */
export interface WritableFacts {
  /** The directory that must be writable to persist the store. */
  dir: string;
  /**
   * True when a probe write into `dir` (or, for a not-yet-created store, its
   * nearest existing ancestor) succeeded.
   */
  writable: boolean;
  /**
   * True when the store's own directory doesn't exist yet — the queue will
   * `mkdir` it on first flush, so we probe the nearest existing ancestor.
   */
  willCreate: boolean;
  /** When not writable, the OS error text (e.g. "EACCES: permission denied"). */
  error?: string;
}

/** Facts about the config file, gathered by the CLI before judging. */
export interface ConfigFacts {
  /** Resolved config-file path, or null when none was found. */
  path: string | null;
  /** Set when a file was found but couldn't be read/parsed. */
  loadError: string | null;
  /** Semantic issues from `validateConfig` (empty when none / no file). */
  issues: ConfigIssue[];
}

/** Facts about configured notification channels. */
export interface NotifyFacts {
  /** Slack incoming-webhook URL, if set. */
  slackWebhook?: string;
  /** Generic webhook endpoint, if set. */
  webhookUrl?: string;
}

/**
 * Whether a single agent binary (a job's `command[0]`) resolved on PATH. The CLI
 * does the actual PATH lookup (filesystem); this module only judges the result.
 */
export interface BinaryFact {
  /** The executable name as it appears in a job command, e.g. "claude". */
  binary: string;
  /** True when the binary resolved to an executable on PATH (or a direct path). */
  found: boolean;
  /** Absolute path it resolved to, when found — shown in the OK message. */
  resolvedPath?: string;
  /** How many active jobs will re-spawn this binary on resume. */
  neededBy: number;
}

/**
 * Facts about the resume-loop heartbeat, gathered by the CLI (which reads the
 * file and knows the wall clock) before judging. The heartbeat proves a
 * `daemon`/`tick` resume loop is alive; combined with how many jobs are waiting,
 * `doctor` can catch the #1 silent failure: jobs queued to resume with nothing
 * running to resume them.
 */
export interface HeartbeatFacts {
  /** True when a heartbeat file exists and parsed into a usable record. */
  present: boolean;
  /** How the writer runs (only when {@link present}). */
  mode?: HeartbeatMode;
  /** Age in ms of the last tick (`now - lastTickAt`), when present & parseable. */
  ageMs?: number;
  /** Staleness threshold in ms; an {@link ageMs} beyond this means "not alive". */
  staleAfterMs?: number;
  /** Writer PID, surfaced in the message so a user can locate the process. */
  pid?: number;
}

/**
 * One `waiting_for_reset` job parked on an implausibly-distant reset. The parser
 * rejects such resets at *enqueue* time (see {@link isPlausibleReset}), but a job
 * can still carry one: it was queued before the horizon guard existed, imported
 * from another machine's dump, or parked while the guard was disabled. The relay
 * never revisits a waiting job's `resetAt`, so it sits silent for days/years with
 * nothing but this check to surface it.
 */
export interface FarFutureReset {
  /** The job's id (full — the CLI shortens it for display). */
  id: string;
  /** The job's project, for a human-recognizable label. */
  project: string;
  /** The ISO reset timestamp the job is parked on. */
  resetAt: string;
  /** Milliseconds from `now` until that reset (always beyond the horizon). */
  msUntil: number;
}

/**
 * Facts about jobs stuck on a distant rate-limit reset, gathered by the CLI
 * (which has the clock and the configured horizon) before judging.
 */
export interface ResetHorizonFacts {
  /**
   * The advisory horizon (ms) used to judge "too far in the future". `doctor`
   * always advises even when the *enqueue-time* guard is disabled, so this is a
   * concrete positive number (the CLI falls back to the built-in default).
   */
  horizonMs: number;
  /** Waiting jobs whose reset is beyond {@link horizonMs}, farthest-first. */
  farFuture: FarFutureReset[];
}

/** Facts about the agent binaries the queued jobs will re-spawn. */
export interface AdapterFacts {
  /**
   * Distinct `command[0]` binaries across the *active* jobs (the only ones the
   * relay will re-spawn), each with whether it resolved on PATH. Empty when no
   * job is waiting to resume — there's nothing to launch, so nothing to check.
   */
  binaries: BinaryFact[];
}

/** Everything {@link runDiagnostics} needs — collected by the CLI, judged here. */
export interface DiagnosticInput {
  /** Running Node version string, e.g. `process.version` ("v22.5.0"). */
  nodeVersion: string;
  store: StoreFacts;
  writable: WritableFacts;
  config: ConfigFacts;
  notify: NotifyFacts;
  adapters: AdapterFacts;
  heartbeat: HeartbeatFacts;
  resetHorizon: ResetHorizonFacts;
}

/** Minimum supported Node version — mirrors the packages' `engines.node`. */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 5;

/** The non-terminal statuses that make a job "active" (still being relayed). */
const ACTIVE_STATUSES = new Set<RelayJob["status"]>(["queued", "waiting_for_reset", "resuming"]);

/** Count jobs still in flight — handy for the CLI to build {@link StoreFacts}. */
export function countActiveJobs(jobs: RelayJob[]): number {
  return jobs.filter((job) => ACTIVE_STATUSES.has(job.status)).length;
}

/**
 * The distinct agent binaries (`command[0]`) the *active* jobs will re-spawn on
 * resume, each with how many active jobs need it — the CLI's `doctor` then does
 * a PATH lookup per binary to fill in {@link BinaryFact.found}. Only active jobs
 * count: terminal ones are never re-launched, so a missing binary there is moot.
 * An empty/whitespace `command[0]` (a malformed job) is skipped. Insertion order
 * of first appearance is preserved for a stable report.
 */
export function distinctActiveBinaries(jobs: RelayJob[]): { binary: string; neededBy: number }[] {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    if (!ACTIVE_STATUSES.has(job.status)) continue;
    const binary = job.command[0]?.trim();
    if (!binary) continue;
    counts.set(binary, (counts.get(binary) ?? 0) + 1);
  }
  return [...counts.entries()].map(([binary, neededBy]) => ({ binary, neededBy }));
}

/**
 * The `waiting_for_reset` jobs whose `resetAt` lands beyond `nowMs + horizonMs`
 * — an implausibly distant reset the relay will silently sit on. Reuses the exact
 * {@link isPlausibleReset} bound the parser applies at enqueue time, so an
 * already-parked bad reset is judged by the identical rule. Returned
 * farthest-first (worst offenders lead the report). Only `waiting_for_reset` jobs
 * are considered (that's the one state parked on a `resetAt`); jobs with a null or
 * unparseable `resetAt`, and past-due resets, are skipped. A non-positive /
 * non-finite `horizonMs` means "no guard" → empty (nothing is judged too far).
 */
export function farFutureResets(jobs: RelayJob[], nowMs: number, horizonMs: number): FarFutureReset[] {
  if (!Number.isFinite(horizonMs) || horizonMs <= 0) return [];
  const now = new Date(nowMs);
  const offenders: FarFutureReset[] = [];
  for (const job of jobs) {
    if (job.status !== "waiting_for_reset" || !job.resetAt) continue;
    const resetMs = Date.parse(job.resetAt);
    if (!Number.isFinite(resetMs)) continue;
    // Reuse the parser's plausibility bound: a reset is "too far" exactly when it
    // fails the same future-side check the parser uses to drop misparses.
    if (isPlausibleReset(new Date(resetMs), now, horizonMs)) continue;
    offenders.push({ id: job.id, project: job.project, resetAt: job.resetAt, msUntil: resetMs - nowMs });
  }
  offenders.sort((a, b) => b.msUntil - a.msUntil);
  return offenders;
}

/**
 * Parses a Node version string like `"v22.5.0"` or `"22.5"` into `{major, minor}`,
 * or null when it doesn't start with a numeric `major.minor`. Tolerant of a
 * leading `v` and trailing pre-release/build noise (`-nightly`, `+abc`).
 */
export function parseNodeVersion(version: string): { major: number; minor: number } | null {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** True when `version` meets the {@link MIN_NODE_MAJOR}.{@link MIN_NODE_MINOR} floor. */
export function isSupportedNode(version: string): boolean {
  const parsed = parseNodeVersion(version);
  if (!parsed) return false;
  if (parsed.major !== MIN_NODE_MAJOR) return parsed.major > MIN_NODE_MAJOR;
  return parsed.minor >= MIN_NODE_MINOR;
}

/**
 * Judges already-gathered {@link DiagnosticInput} facts into a
 * {@link DiagnosticReport}. Pure — no filesystem, no env, no clock — so the CLI
 * `doctor` command and tests share exactly these rules.
 *
 * The checks, in order:
 * 1. **node** — the runtime meets the `>=22.5` engines floor.
 * 2. **store** — the job store is readable (corrupt → error; absent → an OK
 *    "will be created" note, since a fresh install has no store yet).
 * 3. **store-writable** — the store directory can actually be written to; if
 *    not, every `flush()` fails and job state is silently lost (error).
 * 4. **adapters** — every agent binary a queued job will re-spawn is on PATH
 *    (a missing one is an error: those jobs can't resume). Skipped-as-OK when
 *    nothing is queued to resume.
 * 5. **daemon** — a resume loop (daemon/tick) is alive, cross-referenced with
 *    how many jobs are waiting: waiting jobs with no live loop is a warning
 *    (they won't resume), otherwise absence is just an informational OK.
 * 6. **reset-horizon** — no waiting job is parked on an implausibly-distant
 *    reset (a misparse the relay would silently sit on for days/years) → a
 *    warning listing the offenders, else OK.
 * 7. **config** — the config file (if any) loads and validates; a broken file
 *    is an error, semantic warnings are surfaced as warnings.
 * 8. **notify** — at least one notification channel is set (absence is a
 *    warning, not an error: notifications are optional but you'd want to know
 *    the relay can't reach you).
 */
export function runDiagnostics(input: DiagnosticInput): DiagnosticReport {
  const checks: DiagnosticCheck[] = [];

  checks.push(nodeCheck(input.nodeVersion));
  checks.push(storeCheck(input.store));
  checks.push(writableCheck(input.writable));
  checks.push(adapterCheck(input.adapters));
  checks.push(daemonCheck(input.heartbeat, input.store));
  checks.push(resetHorizonCheck(input.resetHorizon));
  checks.push(configCheck(input.config));
  checks.push(notifyCheck(input.notify));

  const counts: Record<DiagnosticLevel, number> = { ok: 0, warning: 0, error: 0 };
  for (const check of checks) counts[check.level] += 1;

  return { checks, ok: counts.error === 0, counts };
}

function nodeCheck(version: string): DiagnosticCheck {
  const floor = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`;
  const parsed = parseNodeVersion(version);
  if (!parsed) {
    return {
      name: "node-version",
      level: "warning",
      message: `could not parse Node version "${version}"`,
      hint: `AgentRelay expects Node ${floor} or newer.`,
    };
  }
  if (!isSupportedNode(version)) {
    return {
      name: "node-version",
      level: "error",
      message: `Node ${parsed.major}.${parsed.minor} is below the required ${floor}`,
      hint: `Upgrade to Node ${floor}+ (nvm install ${MIN_NODE_MAJOR}).`,
    };
  }
  return {
    name: "node-version",
    level: "ok",
    message: `Node ${parsed.major}.${parsed.minor} meets the ${floor}+ requirement`,
  };
}

function storeCheck(store: StoreFacts): DiagnosticCheck {
  if (store.corrupt) {
    return {
      name: "store",
      level: "error",
      message: `job store at ${store.path} is corrupt and was moved aside`,
      hint: "Restore a snapshot with `agentrelay restore`, or start fresh (a new empty store was created).",
    };
  }
  if (!store.exists) {
    return {
      name: "store",
      level: "ok",
      message: `no job store yet at ${store.path} (it will be created on first run)`,
    };
  }
  const active = store.activeCount > 0 ? `, ${store.activeCount} active` : "";
  return {
    name: "store",
    level: "ok",
    message: `job store at ${store.path} is readable (${store.jobCount} job(s)${active})`,
  };
}

function writableCheck(writable: WritableFacts): DiagnosticCheck {
  if (!writable.writable) {
    const reason = writable.error ? ` (${writable.error})` : "";
    return {
      name: "store-writable",
      level: "error",
      message: `store directory ${writable.dir} is not writable${reason} — job state changes can't be persisted`,
      hint: "Fix the directory's permissions, or set AGENTRELAY_STORE to a writable path.",
    };
  }
  if (writable.willCreate) {
    return {
      name: "store-writable",
      level: "ok",
      message: `store directory ${writable.dir} will be created on first run (its parent is writable)`,
    };
  }
  return { name: "store-writable", level: "ok", message: `store directory ${writable.dir} is writable` };
}

function adapterCheck(adapters: AdapterFacts): DiagnosticCheck {
  const { binaries } = adapters;
  if (binaries.length === 0) {
    return {
      name: "adapters",
      level: "ok",
      message: "no queued jobs waiting to resume — no agent binary to check",
    };
  }
  const missing = binaries.filter((b) => !b.found);
  if (missing.length > 0) {
    const names = missing.map((b) => b.binary).join(", ");
    return {
      name: "adapters",
      level: "error",
      message: `${missing.length} of ${binaries.length} agent binary/binaries not on PATH: ${names} — queued jobs will fail to resume`,
      hint: `Install the tool(s) or add them to PATH (check with \`which ${missing[0].binary}\`).`,
    };
  }
  const names = binaries.map((b) => (b.resolvedPath ? `${b.binary} (${b.resolvedPath})` : b.binary)).join(", ");
  return {
    name: "adapters",
    level: "ok",
    message: `all ${binaries.length} agent binary/binaries resolve on PATH: ${names}`,
  };
}

/** Compact human age like "3s", "5m", "2h" for a heartbeat's tick age. */
function humanizeAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Judges resume-loop liveness. The severity hinges on whether any job is
 * actually waiting to resume (`store.activeCount`), because that's what makes a
 * missing loop *matter*:
 *
 * - **Jobs waiting, no live loop** (absent or stale heartbeat) → warning: those
 *   jobs won't resume until a daemon/tick runs. This is the failure this check
 *   exists to surface.
 * - **Jobs waiting, live loop** → ok: they'll be picked up.
 * - **Nothing waiting** → ok regardless: a live loop is noted, an absent one is
 *   fine (there's nothing to resume), a stale one is a mild "may have stopped".
 */
function daemonCheck(heartbeat: HeartbeatFacts, store: StoreFacts): DiagnosticCheck {
  const waiting = store.activeCount;
  const alive =
    heartbeat.present && heartbeat.ageMs !== undefined && heartbeat.staleAfterMs !== undefined
      ? heartbeat.ageMs <= heartbeat.staleAfterMs
      : false;

  if (heartbeat.present && alive) {
    const age = heartbeat.ageMs !== undefined ? humanizeAge(heartbeat.ageMs) : "just now";
    const who = heartbeat.mode === "tick" ? "tick" : "daemon";
    const pid = heartbeat.pid !== undefined ? ` (pid ${heartbeat.pid})` : "";
    const tail = waiting > 0 ? ` — ${waiting} waiting job(s) will resume` : "";
    return {
      name: "daemon",
      level: "ok",
      message: `resume loop is alive: ${who}${pid}, last tick ${age} ago${tail}`,
    };
  }

  // Present but stale: the writer left a heartbeat but hasn't ticked in a while.
  if (heartbeat.present) {
    const age = heartbeat.ageMs !== undefined ? humanizeAge(heartbeat.ageMs) : "a while";
    const pid = heartbeat.pid !== undefined ? ` (pid ${heartbeat.pid})` : "";
    if (waiting > 0) {
      return {
        name: "daemon",
        level: "warning",
        message: `resume loop looks stopped: last tick ${age} ago${pid}, but ${waiting} job(s) are waiting to resume`,
        hint: "Restart it: run `agentrelay daemon` (or schedule `agentrelay tick` via cron).",
      };
    }
    return {
      name: "daemon",
      level: "warning",
      message: `resume loop heartbeat is stale (last tick ${age} ago${pid}) — the daemon may have stopped`,
      hint: "If you expect it running, start `agentrelay daemon` again.",
    };
  }

  // No heartbeat at all.
  if (waiting > 0) {
    return {
      name: "daemon",
      level: "warning",
      message: `${waiting} job(s) are waiting to resume but no resume loop is running — they won't resume on their own`,
      hint: "Start `agentrelay daemon` (or schedule `agentrelay tick` via cron) to auto-resume queued jobs.",
    };
  }
  return {
    name: "daemon",
    level: "ok",
    message: "no resume loop running, and no jobs are waiting to resume",
  };
}

/**
 * Judges whether any waiting job is stuck on a distant reset. This is the
 * queue-side companion to the parser's enqueue-time horizon guard: the parser
 * stops a bad reset from *entering* the queue, but jobs already parked on one
 * (queued before the guard, imported, or parked while it was disabled) are never
 * revisited — the relay just waits. A single offender is enough for a warning,
 * because a job that won't resume for weeks is almost always a misparse.
 */
function resetHorizonCheck(facts: ResetHorizonFacts): DiagnosticCheck {
  const { farFuture, horizonMs } = facts;
  if (farFuture.length === 0) {
    return {
      name: "reset-horizon",
      level: "ok",
      message: `no waiting job is parked on an implausibly distant reset (horizon ${humanizeAge(horizonMs)})`,
    };
  }
  const worst = farFuture[0];
  const label = `job ${worst.id.slice(0, 8)} (${worst.project}) resets in ${humanizeAge(worst.msUntil)}`;
  const more = farFuture.length > 1 ? ` (+${farFuture.length - 1} more)` : "";
  return {
    name: "reset-horizon",
    level: "warning",
    message: `${farFuture.length} waiting job(s) parked beyond the ${humanizeAge(horizonMs)} reset horizon — worst: ${label}${more}, likely a misparse the relay will sit on`,
    hint: `Inspect with \`agentrelay show ${worst.id.slice(0, 8)}\`; if wrong, \`agentrelay retry ${worst.id.slice(0, 8)}\` to resume now or \`agentrelay cancel\` to drop it.`,
  };
}

function configCheck(config: ConfigFacts): DiagnosticCheck {
  if (config.loadError) {
    return {
      name: "config",
      level: "error",
      message: `config file could not be loaded — ${config.loadError}`,
      hint: "Fix the JSON, or run `agentrelay config validate` for details.",
    };
  }
  if (!config.path) {
    return {
      name: "config",
      level: "ok",
      message: "no config file (using environment variables and built-in defaults)",
    };
  }
  const errors = config.issues.filter((issue) => issue.level === "error");
  if (errors.length > 0) {
    const first = errors[0];
    return {
      name: "config",
      level: "error",
      message: `config file ${config.path} has ${errors.length} error(s), e.g. ${first.path} ${first.message}`,
      hint: "Run `agentrelay config validate` to see every problem.",
    };
  }
  const warnings = config.issues.filter((issue) => issue.level === "warning");
  if (warnings.length > 0) {
    const first = warnings[0];
    return {
      name: "config",
      level: "warning",
      message: `config file ${config.path} loads but has ${warnings.length} warning(s), e.g. ${first.path} ${first.message}`,
      hint: "Run `agentrelay config validate` for the full list.",
    };
  }
  return { name: "config", level: "ok", message: `config file ${config.path} is valid` };
}

function notifyCheck(notify: NotifyFacts): DiagnosticCheck {
  const channels: string[] = [];
  if (notify.slackWebhook?.trim()) channels.push("Slack");
  if (notify.webhookUrl?.trim()) channels.push("webhook");
  if (channels.length === 0) {
    return {
      name: "notify",
      level: "warning",
      message: "no notification channel configured — you won't be alerted when a job resumes or fails",
      hint: "Set AGENTRELAY_SLACK_WEBHOOK or AGENTRELAY_WEBHOOK_URL (optional).",
    };
  }
  return { name: "notify", level: "ok", message: `notifications on via ${channels.join(" + ")}` };
}
