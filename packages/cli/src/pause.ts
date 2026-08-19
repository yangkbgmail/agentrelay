// Rendering for `agentrelay pause` / `agentrelay unpause` — the global "hold all
// resumes" switch. Where `snooze`/`cancel`/`retry` act on a single job and
// `drain`/`wait` block until the queue catches up, pausing is a store-wide
// toggle that keeps jobs queued (countdowns still ticking) while the scheduler
// holds every resume. These are pure formatting functions, split from the
// commander wiring so the output is testable without a clock or a filesystem.

import type { PauseState } from "@agentrelay/core";
import type { PauseRelayResult, UnpauseRelayResult } from "./commands.js";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

/** Shown by `unpause` (and `pause --status`) when nothing was paused. */
export const NOT_PAUSED_MESSAGE = "Relay is not paused.";

function agePhrase(pausedAt: string, now: number): string {
  const since = Date.parse(pausedAt);
  if (Number.isNaN(since)) return `paused at ${pausedAt}`;
  const ageMs = now - since;
  if (ageMs < 0) return `paused at ${pausedAt}`;
  return `paused ${formatDurationMs(ageMs)} ago (${pausedAt})`;
}

/**
 * Human-friendly confirmation for `agentrelay pause`. Reports whether this newly
 * paused the relay or refreshed an existing hold, the "paused since" age, and
 * any reason — plus a hint that jobs stay queued and how to resume.
 */
export function renderPauseResult(result: PauseRelayResult, options: { now?: number; color?: boolean } = {}): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${YELLOW}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  const headline = result.alreadyPaused ? "Relay was already paused." : "Relay paused.";
  const lines = [`${b(`⏸ ${headline}`)}  ${d(agePhrase(result.state.pausedAt, now))}`];
  if (result.state.reason) lines.push(`  reason: ${result.state.reason}`);
  lines.push(d("  Jobs stay queued and keep counting down; no resumes until 'agentrelay unpause'."));
  return lines.join("\n");
}

/**
 * Human-friendly confirmation for `agentrelay unpause`. When nothing was paused
 * it reports the no-op; otherwise it confirms resumes will proceed next tick and
 * echoes how long the relay had been held.
 */
export function renderUnpauseResult(
  result: UnpauseRelayResult,
  options: { now?: number; color?: boolean } = {}
): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  const g = (s: string): string => (color ? `${BOLD}${GREEN}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (!result.wasPaused) return NOT_PAUSED_MESSAGE;
  const held = result.previous
    ? `  ${d(`(held for ${formatDurationMs(Math.max(0, now - Date.parse(result.previous.pausedAt)))})`)}`
    : "";
  return `${g("▶ Relay unpaused.")}${held}\n${d("  Due jobs resume on the next tick.")}`;
}

/** Machine-readable form of a `pause` result for `--json`. */
export function renderPauseResultJson(
  result: PauseRelayResult,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify(
    {
      storePath: result.storePath,
      generatedAt,
      paused: true,
      alreadyPaused: result.alreadyPaused,
      state: result.state,
    },
    null,
    2
  );
}

/** Machine-readable form of an `unpause` result for `--json`. */
export function renderUnpauseResultJson(
  result: UnpauseRelayResult,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify(
    { storePath: result.storePath, generatedAt, paused: false, wasPaused: result.wasPaused, previous: result.previous },
    null,
    2
  );
}

/**
 * Machine-readable pause-state query for `pause --status --json`. `state` is
 * null when the relay isn't paused.
 */
export function renderPauseStatusJson(
  state: PauseState | null,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify({ storePath, generatedAt, paused: state !== null, state }, null, 2);
}

/** Human-readable pause-state query for `pause --status`. */
export function renderPauseStatus(state: PauseState | null, options: { now?: number; color?: boolean } = {}): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  if (!state) return NOT_PAUSED_MESSAGE;
  const b = (s: string): string => (color ? `${BOLD}${YELLOW}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const head = `${b("⏸ Relay is paused.")}  ${d(agePhrase(state.pausedAt, now))}`;
  return state.reason ? `${head}\n  reason: ${state.reason}` : head;
}
