import { dirname, join } from "node:path";

/**
 * Daemon/tick liveness heartbeat for `agentrelay doctor`.
 *
 * AgentRelay's whole value is auto-resuming a job when its rate-limit window
 * resets. But that only happens if a resume loop is actually running — either
 * the long-lived `agentrelay daemon` or a cron-scheduled `agentrelay tick`. The
 * single most common "why didn't it work" is: a job was queued to
 * `waiting_for_reset`, the reset time came and went, and *nothing was running
 * to pick it up*, so it sits there forever.
 *
 * To make that visible, the daemon (and each one-shot `tick`) writes a small
 * heartbeat file next to the job store. `doctor` reads it and, crucially, cross-
 * references it against how many jobs are actually waiting: waiting jobs with no
 * live resume loop is a real problem worth a warning; no heartbeat with nothing
 * waiting is perfectly fine.
 *
 * This module is the *pure* half — the heartbeat's path, schema, (de)serialize,
 * and the staleness rule. The actual file read/write lives in the CLI where the
 * filesystem and clock are, mirroring how `doctor`'s facts are gathered.
 */

/** Heartbeat file name; lives alongside `jobs.json` in the store directory. */
export const DAEMON_HEARTBEAT_FILENAME = "daemon.json";

/**
 * How the resume loop that wrote the heartbeat is running:
 * - `daemon` — a long-lived `agentrelay daemon` process polling every
 *   `pollIntervalMs`; staleness is judged against that interval.
 * - `tick` — a one-shot `agentrelay tick` (typically driven by cron); it exits
 *   immediately, so "liveness" means "a tick ran recently" against a generous
 *   fixed window rather than a poll interval.
 */
export type HeartbeatMode = "daemon" | "tick";

/** The on-disk heartbeat record. Kept intentionally tiny and forward-tolerant. */
export interface DaemonHeartbeat {
  /** OS process id of the writer, shown in `doctor` so a user can find/kill it. */
  pid: number;
  /** How the writer runs — see {@link HeartbeatMode}. */
  mode: HeartbeatMode;
  /** ISO timestamp when this resume loop first started (daemon) or ran (tick). */
  startedAt: string;
  /** ISO timestamp of the most recent tick — the actual liveness signal. */
  lastTickAt: string;
  /**
   * The daemon's poll interval in ms (0 for one-shot `tick`). Lets `doctor`
   * derive an honest staleness threshold instead of guessing a fixed timeout.
   */
  pollIntervalMs: number;
}

/** Absolute path of the heartbeat file for a given store path. Pure. */
export function daemonHeartbeatPath(storePath: string): string {
  return join(dirname(storePath), DAEMON_HEARTBEAT_FILENAME);
}

/** Serialize a heartbeat to the exact JSON shape written to disk. */
export function serializeDaemonHeartbeat(heartbeat: DaemonHeartbeat): string {
  return JSON.stringify(heartbeat, null, 2);
}

const VALID_MODES = new Set<HeartbeatMode>(["daemon", "tick"]);

/**
 * Parse a heartbeat file's contents, returning null for anything malformed —
 * bad JSON, wrong shape, missing/typed-wrong fields. A stale writer or a partial
 * write must never crash `doctor`; it just reads as "no usable heartbeat". An
 * unknown/absent `mode` (e.g. from a forward-incompatible writer) is coerced to
 * `daemon` when a positive `pollIntervalMs` is present, else `tick`, so an older
 * reader still gets a sensible staleness rule.
 */
export function parseDaemonHeartbeat(raw: string): DaemonHeartbeat | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;

  const pid = obj.pid;
  const startedAt = obj.startedAt;
  const lastTickAt = obj.lastTickAt;
  const pollIntervalMs = obj.pollIntervalMs;
  if (typeof pid !== "number" || !Number.isFinite(pid)) return null;
  if (typeof startedAt !== "string" || typeof lastTickAt !== "string") return null;
  if (typeof pollIntervalMs !== "number" || !Number.isFinite(pollIntervalMs)) return null;

  const mode: HeartbeatMode = VALID_MODES.has(obj.mode as HeartbeatMode)
    ? (obj.mode as HeartbeatMode)
    : pollIntervalMs > 0
      ? "daemon"
      : "tick";

  return { pid, mode, startedAt, lastTickAt, pollIntervalMs };
}

/**
 * Multiplier on the daemon's poll interval before a heartbeat is "stale": we
 * allow a few missed ticks (slow disk, a long-running resume) before declaring
 * the loop dead, to avoid flapping.
 */
export const HEARTBEAT_STALE_FACTOR = 3;
/** Floor on the daemon staleness window so a fast poll (e.g. 5s) isn't jumpy. */
export const HEARTBEAT_MIN_STALE_AFTER_MS = 60_000;
/**
 * Staleness window for one-shot `tick` mode. We can't know the cron cadence, so
 * we treat "a tick ran within the last 15 minutes" as evidence the resume loop
 * is being driven. Generous on purpose — a false "not running" warning is worse
 * than a slightly delayed one.
 */
export const HEARTBEAT_TICK_STALE_AFTER_MS = 15 * 60_000;

/**
 * The age (ms) beyond which a heartbeat is considered stale, derived purely from
 * how the writer runs. For a daemon it's `pollIntervalMs * factor` (with a
 * floor); for a one-shot tick it's a fixed generous window. Pure — no clock.
 */
export function heartbeatStaleAfterMs(mode: HeartbeatMode, pollIntervalMs: number): number {
  if (mode === "tick" || pollIntervalMs <= 0) return HEARTBEAT_TICK_STALE_AFTER_MS;
  return Math.max(pollIntervalMs * HEARTBEAT_STALE_FACTOR, HEARTBEAT_MIN_STALE_AFTER_MS);
}

/**
 * The liveness of the resume loop, distilled to three states the way a human
 * reads it:
 * - `alive` — a daemon/tick heartbeat exists and ticked within its staleness
 *   window; queued jobs will be picked up.
 * - `stale` — a heartbeat exists but hasn't ticked recently; the loop probably
 *   stopped (crash, killed, cron not firing).
 * - `absent` — no heartbeat file at all; no resume loop has run.
 */
export type HeartbeatLiveness = "alive" | "stale" | "absent";

/**
 * A UI-ready judgment of the resume loop's health. Unlike `doctor`'s
 * {@link DiagnosticCheck} (which bakes in CLI-flavored messages/hints), this is
 * plain structured data any surface — the dashboard, a status endpoint — can
 * render however it likes, while still agreeing with `doctor` on the underlying
 * alive/stale/absent decision.
 */
export interface HeartbeatStatus {
  /** The distilled liveness — see {@link HeartbeatLiveness}. */
  state: HeartbeatLiveness;
  /** How the writer runs (only when a heartbeat is present). */
  mode?: HeartbeatMode;
  /** Writer PID, so a user can locate/kill the process (present only). */
  pid?: number;
  /** ISO timestamp of the last tick (present only). */
  lastTickAt?: string;
  /** Age in ms of the last tick (`now - lastTickAt`), when parseable. */
  ageMs?: number;
  /** Staleness threshold in ms; an {@link ageMs} beyond it means "not alive". */
  staleAfterMs?: number;
  /** Active jobs that depend on the loop running (queued/waiting/resuming). */
  waitingJobs: number;
  /**
   * True when the state is actually a problem: jobs are waiting to resume but
   * the loop isn't alive, so they won't resume on their own. A stale/absent
   * loop with nothing waiting is fine and reads as not concerning.
   */
  concerning: boolean;
}

/**
 * Judge a (possibly missing) heartbeat into a {@link HeartbeatStatus}, pure. The
 * caller supplies `nowMs` and how many jobs are waiting so this stays clock- and
 * filesystem-free. Mirrors `doctor`'s alive/stale rule (`ageMs <= staleAfterMs`)
 * so both surfaces agree, but returns structured data instead of a message.
 *
 * A `lastTickAt` that won't parse (NaN age) is treated as stale — an unusable
 * timestamp is not evidence the loop is alive.
 */
export function evaluateHeartbeat(
  heartbeat: DaemonHeartbeat | null,
  options: { nowMs: number; waitingJobs: number }
): HeartbeatStatus {
  const waitingJobs = Math.max(0, Math.floor(options.waitingJobs));

  if (heartbeat === null) {
    return { state: "absent", waitingJobs, concerning: waitingJobs > 0 };
  }

  const lastTickMs = new Date(heartbeat.lastTickAt).getTime();
  const rawAge = options.nowMs - lastTickMs;
  const ageMs = Number.isFinite(rawAge) ? rawAge : undefined;
  const staleAfterMs = heartbeatStaleAfterMs(heartbeat.mode, heartbeat.pollIntervalMs);
  const alive = ageMs !== undefined && ageMs <= staleAfterMs;
  const state: HeartbeatLiveness = alive ? "alive" : "stale";

  return {
    state,
    mode: heartbeat.mode,
    pid: heartbeat.pid,
    lastTickAt: heartbeat.lastTickAt,
    ageMs,
    staleAfterMs,
    waitingJobs,
    concerning: !alive && waitingJobs > 0,
  };
}

/**
 * Why a would-be second daemon should (or shouldn't) refuse to start:
 * - `no-heartbeat` — no heartbeat file; nothing is running, safe to start.
 * - `not-daemon` — the heartbeat is from a one-shot `tick`, which exits
 *   immediately and holds no long-lived lock; a daemon can start alongside it.
 * - `self` — the heartbeat's pid is our own process; not a competitor.
 * - `stale-dead` — a daemon heartbeat exists but the writer is gone (its pid is
 *   not alive, or — when we can't probe — it's past its staleness window), so
 *   it's a crash leftover we can safely take over from.
 * - `live` — a daemon heartbeat exists and its writer appears to still be
 *   running; starting a second one would double-resume every job.
 */
export type DaemonConflictReason = "no-heartbeat" | "not-daemon" | "self" | "stale-dead" | "live";

/**
 * A pure judgment of whether starting a new daemon on this store would collide
 * with one that's already running. Two daemons polling the same JSON store both
 * spawn the resume command for every due job — the job runs twice. This guards
 * against that most-damaging footgun.
 */
export interface DaemonConflict {
  /** True only when a live competing daemon appears to be running. */
  conflict: boolean;
  /** Why — see {@link DaemonConflictReason}. */
  reason: DaemonConflictReason;
  /** The existing heartbeat's writer pid, when there is a heartbeat. */
  pid?: number;
  /** How the existing writer runs (present only when a heartbeat exists). */
  mode?: HeartbeatMode;
  /** ISO timestamp of the existing writer's last tick (present only). */
  lastTickAt?: string;
  /** Whether the existing daemon heartbeat is past its staleness window. */
  stale?: boolean;
}

/**
 * Decide, purely, whether a new daemon should refuse to start because another
 * daemon is already watching this store. The caller supplies `nowMs`, its own
 * `ownPid`, and — best-effort — whether the heartbeat's pid is currently alive
 * (`pidAlive`), which the CLI probes with a signal-0 `process.kill`. When
 * liveness can't be determined (`pidAlive` undefined, e.g. a cross-user EPERM or
 * no probe available), we fall back to the staleness window: a fresh daemon
 * heartbeat is assumed alive (conflict), a stale one is assumed dead.
 *
 * Conservative by design — we only report a conflict when there's real evidence
 * a daemon is running, so a legitimate restart after a crash is never blocked.
 * Filesystem/OS/clock all stay in the caller.
 */
export function detectDaemonConflict(
  heartbeat: DaemonHeartbeat | null,
  options: { nowMs: number; ownPid: number; pidAlive?: boolean }
): DaemonConflict {
  if (heartbeat === null) {
    return { conflict: false, reason: "no-heartbeat" };
  }

  const base = { pid: heartbeat.pid, mode: heartbeat.mode, lastTickAt: heartbeat.lastTickAt };

  // A one-shot `tick` heartbeat is not a long-lived competitor.
  if (heartbeat.mode !== "daemon") {
    return { conflict: false, reason: "not-daemon", ...base };
  }
  // Our own heartbeat (e.g. a re-entrant start) is never a conflict.
  if (heartbeat.pid === options.ownPid) {
    return { conflict: false, reason: "self", ...base };
  }

  const lastTickMs = new Date(heartbeat.lastTickAt).getTime();
  const rawAge = options.nowMs - lastTickMs;
  const staleAfterMs = heartbeatStaleAfterMs(heartbeat.mode, heartbeat.pollIntervalMs);
  // An unparseable timestamp counts as stale — not evidence the loop is alive.
  const stale = !Number.isFinite(rawAge) || rawAge > staleAfterMs;

  // A definitive "not alive" from the OS probe wins over staleness: the writer
  // is gone even if its heartbeat is recent (a crash that left a fresh file).
  if (options.pidAlive === false) {
    return { conflict: false, reason: "stale-dead", stale, ...base };
  }
  // Definitively alive, or (probe unavailable) a still-fresh daemon heartbeat.
  const alive = options.pidAlive === true || !stale;
  return {
    conflict: alive,
    reason: alive ? "live" : "stale-dead",
    stale,
    ...base,
  };
}
