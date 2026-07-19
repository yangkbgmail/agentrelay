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
