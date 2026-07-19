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
 * A parsed heartbeat turned into the age/staleness facts a reader needs. This is
 * the pure kernel shared by every consumer that reads the file — `doctor`'s CLI
 * fact-gatherer and the dashboard both call it so they judge liveness the same
 * way. Returns null when `lastTickAt` isn't a parseable timestamp (treated as
 * "no usable heartbeat", same as a missing file).
 */
export interface HeartbeatLiveness {
  mode: HeartbeatMode;
  pid: number;
  /** Milliseconds since the last tick (clamped at 0 for clock skew). */
  ageMs: number;
  /** Threshold beyond which {@link ageMs} counts as stale, per {@link heartbeatStaleAfterMs}. */
  staleAfterMs: number;
  /** True when the last tick is within the staleness window. */
  live: boolean;
}

/** Derive age/staleness liveness facts from a heartbeat + the current time. Pure. */
export function heartbeatLiveness(heartbeat: DaemonHeartbeat, nowMs: number): HeartbeatLiveness | null {
  const lastTick = Date.parse(heartbeat.lastTickAt);
  if (Number.isNaN(lastTick)) return null;
  const ageMs = Math.max(0, nowMs - lastTick);
  const staleAfterMs = heartbeatStaleAfterMs(heartbeat.mode, heartbeat.pollIntervalMs);
  return {
    mode: heartbeat.mode,
    pid: heartbeat.pid,
    ageMs,
    staleAfterMs,
    live: ageMs <= staleAfterMs,
  };
}

/**
 * The state of the resume loop as far as a heartbeat can tell:
 * - `running` — a fresh heartbeat: a daemon/tick is actively driving resumes.
 * - `stale` — a heartbeat exists but hasn't ticked within its window; the loop
 *   likely stopped (crash, killed, cron unscheduled).
 * - `absent` — no usable heartbeat at all; nothing is running.
 */
export type ResumeLoopState = "running" | "stale" | "absent";

/**
 * A dashboard-friendly verdict on whether jobs will actually get resumed. Mirrors
 * the severity logic of `doctor`'s daemon check but returns structured data (not a
 * formatted CLI line) so a UI can pick its own colors/copy. The key field is
 * {@link needsAttention}: jobs are waiting *and* no live loop is running — the one
 * situation where the whole tool silently does nothing.
 */
export interface ResumeLoopHealth {
  state: ResumeLoopState;
  /** True only when a heartbeat is present and fresh. */
  live: boolean;
  /** Jobs in a state that needs a resume loop (queued/waiting/resuming). */
  activeCount: number;
  /** Waiting jobs but no live loop — the failure this surface exists to catch. */
  needsAttention: boolean;
  mode?: HeartbeatMode;
  pid?: number;
  ageMs?: number;
  staleAfterMs?: number;
  /** Short status line, e.g. "Resume loop running" / "No resume loop running". */
  headline: string;
  /** One sentence of context suitable for a subtitle. */
  detail: string;
}

/**
 * Judge resume-loop health from liveness facts (null = no usable heartbeat) and
 * how many jobs are waiting. Pure — the caller supplies the parsed liveness and
 * the active-job count. Severity hinges on `activeCount`, exactly like `doctor`:
 * a missing loop only *matters* when something is waiting to resume.
 */
export function resolveResumeLoopHealth(liveness: HeartbeatLiveness | null, activeCount: number): ResumeLoopHealth {
  const waiting = Math.max(0, activeCount);
  const base = { activeCount: waiting } as const;

  if (liveness?.live) {
    const who = liveness.mode === "tick" ? "tick" : "daemon";
    const tail = waiting > 0 ? ` — ${waiting} waiting job(s) will resume` : "";
    return {
      ...base,
      state: "running",
      live: true,
      needsAttention: false,
      mode: liveness.mode,
      pid: liveness.pid,
      ageMs: liveness.ageMs,
      staleAfterMs: liveness.staleAfterMs,
      headline: "Resume loop running",
      detail: `${who} is alive (pid ${liveness.pid})${tail}.`,
    };
  }

  if (liveness) {
    // Present but stale.
    return {
      ...base,
      state: "stale",
      live: false,
      needsAttention: waiting > 0,
      mode: liveness.mode,
      pid: liveness.pid,
      ageMs: liveness.ageMs,
      staleAfterMs: liveness.staleAfterMs,
      headline: "Resume loop stopped",
      detail:
        waiting > 0
          ? `Heartbeat is stale but ${waiting} job(s) are waiting — start \`agentrelay daemon\` to resume them.`
          : "Heartbeat is stale — the daemon may have stopped, but nothing is waiting.",
    };
  }

  // No usable heartbeat.
  if (waiting > 0) {
    return {
      ...base,
      state: "absent",
      live: false,
      needsAttention: true,
      headline: "No resume loop running",
      detail: `${waiting} job(s) are waiting but nothing will resume them — start \`agentrelay daemon\`.`,
    };
  }
  return {
    ...base,
    state: "absent",
    live: false,
    needsAttention: false,
    headline: "No resume loop running",
    detail: "Nothing is waiting to resume, so no daemon is needed right now.",
  };
}
