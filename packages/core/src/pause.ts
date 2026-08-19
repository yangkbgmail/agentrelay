import { dirname, join } from "node:path";

/**
 * Global "hold all resumes" switch for the relay.
 *
 * Unlike per-job controls (`snooze`, `cancel`, `retry`) or the blocking
 * `drain`/`wait` catch-up helpers, pausing is a *store-wide* toggle: while it's
 * active the scheduler keeps polling and refreshing its liveness heartbeat, but
 * does not resume any due job. Jobs stay queued and their countdowns keep
 * ticking, so unpausing lets the whole backlog flow again on the next tick —
 * nothing is lost.
 *
 * The state lives in a small marker file *beside* the JSON store (the same
 * placement the daemon heartbeat uses), so it is shared across every process
 * that touches the store: `agentrelay pause` writes it, a long-running
 * `daemon` (or a cron-driven one-shot `tick`) reads it each cycle, and
 * `agentrelay unpause` removes it. Keeping it out of `jobs.json` means the queue
 * schema is untouched and a pause can't corrupt or race the job list.
 */

/** Basename of the pause marker, written next to the store's `jobs.json`. */
export const PAUSE_FILENAME = "paused.json";

/** Absolute path of the pause marker for a given store path. Pure. */
export function pauseFilePath(storePath: string): string {
  return join(dirname(storePath), PAUSE_FILENAME);
}

/** On-disk shape of the pause marker. */
export interface PauseState {
  /** ISO timestamp when the relay was paused. */
  pausedAt: string;
  /** Optional human note for *why* it was paused, echoed back on `unpause`. */
  reason?: string;
}

/** Serialize a pause state to the exact JSON shape written to disk. */
export function serializePauseState(state: PauseState): string {
  const body: PauseState = { pausedAt: state.pausedAt };
  // Only persist a reason when it carries text, so an empty note doesn't
  // clutter the marker or round-trip back as an empty string.
  if (state.reason !== undefined && state.reason.trim() !== "") {
    body.reason = state.reason;
  }
  return JSON.stringify(body, null, 2);
}

/**
 * Parse a pause marker's contents, returning `null` for anything malformed —
 * bad JSON, wrong shape, or a missing/mistyped `pausedAt`. A partial write or a
 * hand-edited file must never crash the relay loop; the reader treats an
 * unparseable marker as "no usable pause state" and (per {@link isPauseActive})
 * as *not paused*, so a corrupt marker fails open — it can't silently wedge the
 * queue shut. A non-string `reason` is dropped rather than rejected, keeping the
 * marker forward-compatible with extra keys.
 */
export function parsePauseState(raw: string): PauseState | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.pausedAt !== "string" || obj.pausedAt === "") return null;

  const state: PauseState = { pausedAt: obj.pausedAt };
  if (typeof obj.reason === "string" && obj.reason.trim() !== "") {
    state.reason = obj.reason;
  }
  return state;
}

/**
 * Whether a parsed pause marker means the relay is currently held. `null`
 * (absent or corrupt marker) reads as *not paused* so the queue fails open —
 * the safe default for a resume loop whose whole job is to make progress.
 */
export function isPauseActive(state: PauseState | null): boolean {
  return state !== null;
}
