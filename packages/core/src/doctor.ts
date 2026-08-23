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

/**
 * Facts about the *contents* of the job store, gathered by the CLI (which reads
 * the raw file and runs the pure `verifyStore` linter) before judging.
 *
 * {@link StoreFacts} answers "does the file load at all?"; this answers "are the
 * records inside it internally consistent?" — the gap `verifyStore` was written
 * to close. The queue casts on-disk JSON straight to `RelayJob[]` without
 * per-record validation and keys jobs by id in a `Map`, so a hand-edited store,
 * a botched merge, or a record from another build can leave the file perfectly
 * loadable yet semantically broken: a duplicate `id` silently drops the earlier
 * job, a `waiting_for_reset` job with no `resetAt` can never resume. None of
 * that trips the whole-file corruption check, so `doctor` folds the linter's
 * verdict in here as its own check.
 */
export interface StoreIntegrityFacts {
  /**
   * False when there was no readable job array to lint — the store is absent
   * (clean first-run) or its whole file is corrupt (already reported by the
   * `store` check). The integrity check is then a skipped OK, never a second
   * error for the same file.
   */
  checked: boolean;
  /** Records inspected by the linter (0 when not {@link checked}). */
  total: number;
  /**
   * Count of `error`-level integrity issues — a record is unusable or data is
   * being lost (duplicate id, structurally-invalid record).
   */
  errorCount: number;
  /**
   * Count of `warning`-level integrity issues — the store loads but the relay
   * may mis-handle a record (stranded `waiting_for_reset`, unparseable dates,
   * clock skew).
   */
  warningCount: number;
  /**
   * A few representative issue messages (bounded by the CLI) so the report can
   * point at *what* is wrong without dumping every problem.
   */
  sampleIssues: string[];
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

/** Facts about the agent binaries the queued jobs will re-spawn. */
export interface AdapterFacts {
  /**
   * Distinct `command[0]` binaries across the *active* jobs (the only ones the
   * relay will re-spawn), each with whether it resolved on PATH. Empty when no
   * job is waiting to resume — there's nothing to launch, so nothing to check.
   */
  binaries: BinaryFact[];
}

/** A single active job whose `resetAt` lies implausibly far in the future. */
export interface FarFutureResetJob {
  /** The job's id — enough to `agentrelay show <id>` it. */
  id: string;
  /** The job's project, for a human-legible listing. */
  project: string;
  /** The parked reset timestamp (ISO), as stored on the job. */
  resetAt: string;
  /** How far ahead the reset is from "now" (ms) — always beyond the horizon. */
  msUntilReset: number;
}

/**
 * Facts about jobs already parked with an implausibly-distant reset time. The
 * parser's horizon guard (see {@link isPlausibleReset}) only vets *newly parsed*
 * rate-limits, so a job queued before the guard existed — or while it was
 * disabled, or by a misparse that slipped a wrong epoch unit / huge relative
 * span through — can sit `waiting_for_reset` for days or years and never resume.
 * `doctor` re-checks the live queue against the same horizon to surface those.
 */
export interface ResetHorizonFacts {
  /**
   * Active jobs whose `resetAt` is beyond {@link horizonMs} from now. Empty when
   * none are (or when the guard is disabled — see {@link horizonMs}).
   */
  jobs: FarFutureResetJob[];
  /**
   * The horizon (ms) the CLI judged against, or `null` when the reset-horizon
   * guard is disabled (`AGENTRELAY_MAX_RESET_HORIZON=off`) — then there's no
   * bound to flag against and the check is an informational OK.
   */
  horizonMs: number | null;
}

/** Everything {@link runDiagnostics} needs — collected by the CLI, judged here. */
export interface DiagnosticInput {
  /** Running Node version string, e.g. `process.version` ("v22.5.0"). */
  nodeVersion: string;
  store: StoreFacts;
  integrity: StoreIntegrityFacts;
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
 * The *active* jobs whose `resetAt` sits beyond the plausibility horizon — i.e.
 * so far in the future that they've almost certainly misparsed and will never
 * resume in a sane window. Pure: the clock (`now`) and the horizon are injected,
 * so it's directly unit-testable and reusable (the CLI's `doctor` and, later,
 * the dashboard can share it). Only active jobs matter — a terminal job's
 * `resetAt` is history, never acted on again. Jobs with no `resetAt` or an
 * unparseable one are skipped (nothing to judge). A non-positive / non-finite
 * `horizonMs` means "guard disabled" and returns an empty list, mirroring
 * {@link isPlausibleReset}'s "no guard" semantics.
 */
export function selectFarFutureResets(jobs: RelayJob[], opts: { now: Date; horizonMs: number }): FarFutureResetJob[] {
  const { now, horizonMs } = opts;
  if (!Number.isFinite(horizonMs) || horizonMs <= 0) return [];
  const nowMs = now.getTime();
  const out: FarFutureResetJob[] = [];
  for (const job of jobs) {
    if (!ACTIVE_STATUSES.has(job.status)) continue;
    if (!job.resetAt) continue;
    const resetMs = Date.parse(job.resetAt);
    if (Number.isNaN(resetMs)) continue;
    // Beyond the horizon = implausible. `isPlausibleReset` bounds only the
    // future side, so a past/near reset is fine and only the far ones fail.
    if (!isPlausibleReset(new Date(resetMs), now, horizonMs)) {
      out.push({ id: job.id, project: job.project, resetAt: job.resetAt, msUntilReset: resetMs - nowMs });
    }
  }
  return out;
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
 * 3. **store-integrity** — the records *inside* a readable store are internally
 *    consistent (no duplicate id, no structurally-invalid or stranded record);
 *    errors mean data loss, warnings mean the relay may mis-handle a record.
 *    Skipped-as-OK when there's no readable job array to lint.
 * 4. **store-writable** — the store directory can actually be written to; if
 *    not, every `flush()` fails and job state is silently lost (error).
 * 5. **adapters** — every agent binary a queued job will re-spawn is on PATH
 *    (a missing one is an error: those jobs can't resume). Skipped-as-OK when
 *    nothing is queued to resume.
 * 6. **daemon** — a resume loop (daemon/tick) is alive, cross-referenced with
 *    how many jobs are waiting: waiting jobs with no live loop is a warning
 *    (they won't resume), otherwise absence is just an informational OK.
 * 7. **reset-horizon** — no active job is parked with an implausibly-distant
 *    reset time (a misparse that would silently never resume); such jobs are a
 *    warning. Skipped-as-OK when the horizon guard is disabled.
 * 8. **config** — the config file (if any) loads and validates; a broken file
 *    is an error, semantic warnings are surfaced as warnings.
 * 9. **notify** — at least one notification channel is set (absence is a
 *    warning, not an error: notifications are optional but you'd want to know
 *    the relay can't reach you).
 */
export function runDiagnostics(input: DiagnosticInput): DiagnosticReport {
  const checks: DiagnosticCheck[] = [];

  checks.push(nodeCheck(input.nodeVersion));
  checks.push(storeCheck(input.store));
  checks.push(integrityCheck(input.integrity));
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

/**
 * Judges the linter's verdict on a readable store's contents. `verifyStore`
 * already did the work (in the CLI, on the raw pre-cast array); this only maps
 * its counts to a check severity, mirroring how the linter itself grades:
 * `error`-level issues (duplicate id, invalid record) fail the report, warnings
 * (stranded job, unparseable dates) surface as warnings. When there was nothing
 * to lint — store absent, or whole-file corrupt (the `store` check owns that) —
 * it's a skipped OK so the same file isn't flagged twice.
 */
function integrityCheck(integrity: StoreIntegrityFacts): DiagnosticCheck {
  if (!integrity.checked) {
    return {
      name: "store-integrity",
      level: "ok",
      message: "no readable job store to lint yet",
    };
  }
  const sample = integrity.sampleIssues.length > 0 ? ` — ${integrity.sampleIssues.join("; ")}` : "";
  if (integrity.errorCount > 0) {
    return {
      name: "store-integrity",
      level: "error",
      message: `job store has ${integrity.errorCount} integrity error(s) across ${integrity.total} record(s)${sample}`,
      hint: "Inspect them with `agentrelay verify`; e.g. a duplicate id silently drops the earlier job on load.",
    };
  }
  if (integrity.warningCount > 0) {
    return {
      name: "store-integrity",
      level: "warning",
      message: `job store has ${integrity.warningCount} integrity warning(s) across ${integrity.total} record(s)${sample}`,
      hint: "Review them with `agentrelay verify` (e.g. a waiting job with no reset time can never resume).",
    };
  }
  return {
    name: "store-integrity",
    level: "ok",
    message: `all ${integrity.total} store record(s) pass integrity checks`,
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
 * Judges whether any active job is parked with an implausibly-distant reset.
 * The parser's horizon guard only vets freshly-parsed rate-limits; this catches
 * ones that already made it into the queue (guard off at the time, a pre-guard
 * job, or a misparse). Such a job sits `waiting_for_reset` forever — exactly the
 * silent-failure class this tool keeps hunting — so it's a warning, with the
 * offending job(s) named and the one-shot bulk fix (`recover --far-future`)
 * offered.
 */
function resetHorizonCheck(facts: ResetHorizonFacts): DiagnosticCheck {
  if (facts.horizonMs === null) {
    return {
      name: "reset-horizon",
      level: "ok",
      message: "reset-horizon guard is disabled — parked reset times are not bounded",
    };
  }
  const horizon = humanizeAge(facts.horizonMs);
  if (facts.jobs.length === 0) {
    return {
      name: "reset-horizon",
      level: "ok",
      message: `no jobs parked with a reset beyond the ${horizon} horizon`,
    };
  }
  // Report the soonest-past-horizon job first so the example is the least
  // extreme (and thus most likely a real edge case worth a second look).
  const sorted = [...facts.jobs].sort((a, b) => a.msUntilReset - b.msUntilReset);
  const first = sorted[0];
  const example = `${first.id} (${first.project}) resets in ${humanizeAge(first.msUntilReset)}`;
  return {
    name: "reset-horizon",
    level: "warning",
    message: `${facts.jobs.length} job(s) parked with a reset beyond the ${horizon} horizon — likely misparsed, they won't resume for a long time: e.g. ${example}`,
    hint: "Requeue them all with `agentrelay recover --far-future` (plain `recover` won't — it only reclaims jobs stuck resuming). Or inspect one with `agentrelay show <id>`, then `agentrelay cancel <id>` / `agentrelay retry <id>`.",
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
