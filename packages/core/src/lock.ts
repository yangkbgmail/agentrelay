import { type DaemonHeartbeat, heartbeatStaleAfterMs } from "./heartbeat.js";

/**
 * Single-instance guard for `agentrelay daemon`.
 *
 * The relay's job is to auto-resume a rate-limited command once its window
 * resets — exactly once. But nothing stops a user from launching a second
 * `agentrelay daemon` (a forgotten terminal, a launchd/systemd unit *and* a
 * manual run, two machines sharing one store over a synced folder). Two daemons
 * polling the same `jobs.json` both see the same job come due and both spawn the
 * agent, double-executing the very command the relay exists to run carefully.
 * That's the silent-failure family this project keeps hardening against.
 *
 * There's already a liveness signal on disk: the daemon writes a heartbeat
 * (`daemon.json`) next to the store every tick, recording its pid, mode, and
 * last tick time. This module turns that heartbeat into a lock decision: given
 * an existing heartbeat (if any) and whether its pid is still a live process,
 * decide whether it's safe to start a new daemon or whether one already owns the
 * loop.
 *
 * Like the rest of the diagnostics, this is the *pure* judgement layer — no
 * filesystem, no `process.kill`, no clock. The CLI reads the heartbeat file and
 * probes the pid; here we only decide. That keeps every rule unit-testable.
 *
 * Note on the guard's guarantee: it's advisory, not a kernel mutex. Two daemons
 * started in the same instant can both read "no heartbeat" before either writes
 * one (a classic TOCTOU race). The guard reliably catches the common case — a
 * daemon that's *already been running* for a tick or more — which is the one
 * users actually hit; it does not promise mutual exclusion against a simultaneous
 * cold start. A `--force` escape hatch always wins for the rare intentional case.
 */

/** What {@link evaluateDaemonLock} decided to do about starting a new daemon. */
export type DaemonLockAction = "start" | "refuse";

/**
 * Facts about the daemon that currently holds (or last held) the heartbeat,
 * surfaced so the CLI can tell the user which process to look at.
 */
export interface DaemonLockHolder {
  /** The recorded writer pid. */
  pid: number;
  /** How that writer runs — only a live `daemon` can hold the lock. */
  mode: DaemonHeartbeat["mode"];
  /** ISO timestamp of the holder's most recent tick. */
  lastTickAt: string;
  /** Age in ms of that tick (`now - lastTickAt`), or undefined if unparseable. */
  ageMs?: number;
  /** Staleness window used to judge liveness (ms). */
  staleAfterMs: number;
}

/** The verdict from {@link evaluateDaemonLock}. */
export interface DaemonLockDecision {
  action: DaemonLockAction;
  /** Human-readable one-liner explaining the verdict (for the CLI to print). */
  reason: string;
  /**
   * The incumbent daemon's facts, when an existing heartbeat was present —
   * populated on `refuse` (who to stop) and on a "taking over a dead/stale
   * loop" `start` (context), absent only when there was no heartbeat at all.
   */
  holder?: DaemonLockHolder;
}

/** Inputs the CLI collects (clock + pid probe) before asking for a verdict. */
export interface DaemonLockOptions {
  /** Wall-clock now, in ms since epoch. */
  nowMs: number;
  /** The pid of the process about to start a daemon (`process.pid`). */
  selfPid: number;
  /**
   * Whether the heartbeat's recorded pid resolves to a live process — the CLI
   * probes this with `process.kill(pid, 0)`. Only consulted for a `daemon`-mode
   * heartbeat that isn't already stale.
   */
  pidAlive: boolean;
  /**
   * Override the derived staleness window (ms). Defaults to
   * {@link heartbeatStaleAfterMs} for the holder's mode/interval — the same rule
   * `doctor` uses, so "stale here" agrees with "stale there".
   */
  staleAfterMs?: number;
}

/** Compact seconds label for a lock reason, e.g. `3s` / `5m` — no clock. */
function ageLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Decide whether it's safe to start a new daemon given the existing heartbeat.
 * Pure — no filesystem, env, or clock; the caller supplies `nowMs` and the pid
 * probe. The rules, in order:
 *
 * 1. **No heartbeat** → `start`. Nothing is running.
 * 2. **Tick-mode heartbeat** → `start`. A one-shot `tick` writes a heartbeat but
 *    its process has already exited; it never holds the daemon singleton (and
 *    its recorded pid may since have been reused, so we don't trust it).
 * 3. **Our own pid** → `start`. The heartbeat belongs to this very process
 *    (e.g. a restart within one process); not a competing daemon.
 * 4. **Stale heartbeat** → `start`, taking over. It hasn't ticked within its
 *    staleness window — the previous daemon crashed or was killed. An
 *    unparseable `lastTickAt` counts as stale (no evidence of life).
 * 5. **Dead pid** → `start`, taking over. The heartbeat is fresh but its pid is
 *    no longer a live process (a crash between ticks).
 * 6. **Fresh heartbeat, live pid** → `refuse`. A daemon is genuinely running and
 *    owns the resume loop; starting a second would double-resume jobs.
 */
export function evaluateDaemonLock(existing: DaemonHeartbeat | null, options: DaemonLockOptions): DaemonLockDecision {
  if (existing === null) {
    return { action: "start", reason: "no resume loop is running" };
  }

  const staleAfterMs = options.staleAfterMs ?? heartbeatStaleAfterMs(existing.mode, existing.pollIntervalMs);
  const lastTickMs = new Date(existing.lastTickAt).getTime();
  const rawAge = options.nowMs - lastTickMs;
  const ageMs = Number.isFinite(rawAge) ? rawAge : undefined;
  const holder: DaemonLockHolder = {
    pid: existing.pid,
    mode: existing.mode,
    lastTickAt: existing.lastTickAt,
    ageMs,
    staleAfterMs,
  };

  // Only a live long-lived daemon holds the singleton. A tick heartbeat is from
  // an exited one-shot process — never a competing daemon.
  if (existing.mode !== "daemon") {
    return {
      action: "start",
      reason: "the existing heartbeat is a one-shot tick, not a running daemon",
      holder,
    };
  }

  if (existing.pid === options.selfPid) {
    return { action: "start", reason: "the existing heartbeat belongs to this process", holder };
  }

  const fresh = ageMs !== undefined && ageMs <= staleAfterMs;
  if (!fresh) {
    const age = ageMs !== undefined ? ageLabel(ageMs) : "unknown time";
    return {
      action: "start",
      reason: `the previous daemon (pid ${existing.pid}) last ticked ${age} ago — its heartbeat is stale, taking over`,
      holder,
    };
  }

  if (!options.pidAlive) {
    return {
      action: "start",
      reason: `the previous daemon (pid ${existing.pid}) is no longer running — taking over`,
      holder,
    };
  }

  const age = ageMs !== undefined ? ageLabel(ageMs) : "just now";
  return {
    action: "refuse",
    reason: `another daemon is already running (pid ${existing.pid}, last tick ${age} ago)`,
    holder,
  };
}
