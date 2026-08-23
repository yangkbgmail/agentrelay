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
 * The verdict of the daemon single-instance guard: is a live `agentrelay daemon`
 * already running against this store?
 *
 * `running: true` means a second daemon should refuse to start (unless forced),
 * because two daemons polling the same store would both fire on the same due job
 * and double-spawn the resumed command. `running: false` means it's safe to
 * start — no heartbeat, a one-shot `tick` heartbeat, a dead/reused PID, or a
 * stale (crashed/wedged) daemon whose staleness `doctor` already surfaces.
 */
export type DaemonConflict =
  | { running: false }
  | {
      /** A live daemon owns this store; a second one should not start. */
      running: true;
      /** PID of the running daemon, so the user can find/kill it. */
      pid: number;
      /** Age in ms of its last tick (fresh, i.e. within the staleness window). */
      ageMs: number;
      /** ISO timestamp of its last tick. */
      lastTickAt: string;
    };

/**
 * Decide whether a live daemon is already running, so `agentrelay daemon` can
 * refuse to start a second one. Pure: the caller supplies `nowMs` and whether
 * the recorded PID is still alive (`process.kill(pid, 0)` is impure and lives in
 * the CLI), mirroring how the rest of this module keeps clock/filesystem out.
 *
 * A conflict requires ALL of: a `daemon`-mode heartbeat, its PID still alive,
 * and its last tick within the staleness window. We deliberately err toward
 * *allowing* a start on any doubt — a one-shot `tick` heartbeat, an
 * unparseable timestamp, a dead PID, or a stale beat all read as "not running":
 * wrongly blocking a legitimate daemon (annoying, needs `--force`) is worse only
 * than wrongly allowing a second live one (the double-resume bug we're
 * preventing), and requiring a *fresh* beat from a *live* PID makes the latter
 * the case we actually catch while a reused PID with an old file does not
 * falsely block.
 */
export function evaluateDaemonConflict(
  heartbeat: DaemonHeartbeat | null,
  options: { nowMs: number; pidAlive: boolean }
): DaemonConflict {
  if (heartbeat === null) return { running: false };
  // A one-shot `tick` heartbeat is not a long-lived daemon; it never conflicts.
  if (heartbeat.mode !== "daemon") return { running: false };
  // The recorded process is gone (crash/kill) → the file is a ghost, safe to start.
  if (!options.pidAlive) return { running: false };

  const lastTickMs = new Date(heartbeat.lastTickAt).getTime();
  const ageMs = options.nowMs - lastTickMs;
  // Unparseable timestamp → can't confirm freshness → don't block.
  if (!Number.isFinite(ageMs)) return { running: false };

  const staleAfterMs = heartbeatStaleAfterMs("daemon", heartbeat.pollIntervalMs);
  // Stale despite a live PID: probably a wedged daemon or a reused PID. `doctor`
  // surfaces the staleness; don't wrongly block a fresh start on it.
  if (ageMs > staleAfterMs) return { running: false };

  return { running: true, pid: heartbeat.pid, ageMs, lastTickAt: heartbeat.lastTickAt };
}
