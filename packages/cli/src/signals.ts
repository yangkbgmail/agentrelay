/**
 * Signal forwarding for `agentrelay run`.
 *
 * The `run` wrapper spawns the wrapped agent as a child process and streams its
 * output. Before this module, `runCommand` never installed signal handlers on
 * the parent, so:
 *
 *  - When a user pressed Ctrl-C, the TTY sent SIGINT to the whole foreground
 *    process group. The child died, but the parent kept running just long
 *    enough to notice a non-zero exit and then quit without ever getting a
 *    chance to enqueue a partial rate-limit detection or clean up.
 *  - When a supervisor sent SIGTERM to the *parent only* (e.g. systemd stopping
 *    a wrapping unit, `kill <pid>` on the wrapper), the signal was ignored,
 *    the parent stayed alive, and the child kept running — orphaning the
 *    wrapped agent even though the user asked us to stop.
 *  - SIGHUP (terminal closed) behaved the same as SIGTERM: dropped on the
 *    floor, child left dangling.
 *
 * The pattern below is the standard "signal forwarder" for a Node CLI that
 * wraps a child: attach a listener that resends the received signal to the
 * child, remember to remove it once the child exits, and refuse to install two
 * listeners for the same signal (`process.on` stacks them, which would send the
 * signal to the child twice on Ctrl-C).
 *
 * The forwarder is a pure function taking the process-like objects it operates
 * on so `commands.ts` stays a thin wire-up over dependency-free logic and so
 * the whole thing is unit-testable without spawning anything.
 */

/**
 * The POSIX-style signals we forward to the child. We deliberately keep this
 * list small and conservative:
 *
 *   SIGINT   — Ctrl-C from a TTY. Users expect this to propagate.
 *   SIGTERM  — polite "please stop" from a supervisor or `kill`.
 *   SIGHUP   — terminal closed / controlling process gone.
 *
 * We do NOT forward SIGKILL/SIGSTOP (uncatchable on POSIX and can't be sent by
 * a user-mode process anyway), and we do NOT forward SIGQUIT/SIGUSR* (their
 * semantics vary by agent and forwarding blindly can trigger unwanted core
 * dumps or agent-specific behavior the user didn't intend).
 */
export const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** One of {@link FORWARDED_SIGNALS}. */
export type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];

/**
 * The subset of `NodeJS.Process` the forwarder actually touches. Kept minimal so
 * tests can pass a fake event emitter without stubbing all of `process`.
 */
export interface SignalHost {
  on(signal: ForwardedSignal, listener: () => void): unknown;
  off(signal: ForwardedSignal, listener: () => void): unknown;
}

/**
 * The subset of `ChildProcess` the forwarder needs. Real child processes match
 * this shape; the pid can be `undefined` between spawn scheduling and the
 * actual fork (`spawn` returns immediately; on synchronous spawn failure the
 * pid is `undefined`), and `killed` becomes `true` after a successful signal.
 */
export interface SignalTarget {
  readonly pid?: number | undefined;
  readonly killed: boolean;
  kill(signal: ForwardedSignal): boolean;
}

/**
 * Install a signal forwarder that resends each of {@link FORWARDED_SIGNALS} to
 * `child` when the parent receives it. Returns a `dispose` closure the caller
 * MUST invoke once the child has exited so we don't leak listeners on
 * long-running Node processes (e.g. `agentrelay run` invoked repeatedly from
 * the same script).
 *
 * The forwarder is deliberately best-effort:
 *
 *  - If `kill` throws (child already reaped, permission denied), we swallow the
 *    error. A dying wrapper is not a place to add a second failure mode.
 *  - If `child.pid` is `undefined` (spawn hasn't produced a pid yet, or spawn
 *    failed synchronously), we skip the forward — there's nothing to signal.
 *  - If `child.killed` is already set, we skip the forward — the child is
 *    already being torn down.
 *
 * Pure with respect to time and the ambient process: everything it observes
 * comes through `host` and `child`, so a test can drive it deterministically
 * with a fake `EventEmitter` and a stub target.
 */
export function forwardSignals(host: SignalHost, child: SignalTarget): () => void {
  const listeners: Array<[ForwardedSignal, () => void]> = [];
  for (const signal of FORWARDED_SIGNALS) {
    const listener = () => forwardOne(child, signal);
    listeners.push([signal, listener]);
    host.on(signal, listener);
  }
  let disposed = false;
  return () => {
    if (disposed) return; // idempotent — re-invoking after exit is a no-op
    disposed = true;
    for (const [signal, listener] of listeners) {
      host.off(signal, listener);
    }
  };
}

/**
 * POSIX exit-code convention for a process killed by a signal: `128 + signum`.
 * We only need the values for the signals we forward (a wrapped child that
 * dies from any *other* signal isn't something `agentrelay run` initiated).
 * Kept as a fixed table so the wrapper doesn't have to depend on any
 * platform's dynamic signal map, and so the values are portable in tests. An
 * unknown signal name falls back to `1` — a plain "something went wrong" —
 * rather than `0`, which would hide a signal-killed child from the shell.
 */
const SIGNAL_EXIT_CODES: Readonly<Record<ForwardedSignal, number>> = {
  SIGHUP: 129, // 128 + 1
  SIGINT: 130, // 128 + 2
  SIGTERM: 143, // 128 + 15
};

/**
 * Map a signal name (as reported by `child.on("close", (_, signal) => …)`) to
 * the exit code a shell would surface for a child killed by that signal. Pure
 * and independent of the runtime's dynamic signal table.
 */
export function signalExitCode(signal: string): number {
  if (signal in SIGNAL_EXIT_CODES) {
    return SIGNAL_EXIT_CODES[signal as ForwardedSignal];
  }
  return 1;
}

/**
 * Send `signal` to `child`, swallowing the usual "child already gone" errors.
 * Exposed for tests; production callers should use {@link forwardSignals}.
 */
export function forwardOne(child: SignalTarget, signal: ForwardedSignal): boolean {
  if (child.killed) return false;
  if (child.pid === undefined) return false;
  try {
    return child.kill(signal);
  } catch {
    // ESRCH (already reaped), EPERM (dropped priv) — either way, we're done.
    return false;
  }
}
