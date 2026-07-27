import { type ChildProcess, spawn } from "node:child_process";
import { parseDuration } from "./prune.js";
import type { Notifier } from "./scheduler.js";
import type { NotifyPayload } from "./types.js";

/**
 * Event-hook (local command) notifier.
 *
 * Unlike the Slack/webhook notifiers (which POST to a remote HTTP endpoint),
 * this runs a *local* shell command on every relay lifecycle event so a user
 * can wire in desktop notifications (`notify-send`, `terminal-notifier`),
 * append to a log, ring a bell, or trigger any custom script — no network
 * required. It plugs into the same {@link Notifier} abstraction the scheduler
 * already fans out to, so no scheduler changes are needed.
 *
 * Event data is passed to the command through environment variables (never by
 * string interpolation) so an arbitrary project name or message can't inject
 * shell syntax. The command itself is run through the platform shell, so the
 * user can branch on `$AGENTRELAY_EVENT` and pipe/quote freely.
 */

/** Environment variables the hook command receives, describing the event. */
export const HOOK_ENV_VARS = {
  event: "AGENTRELAY_EVENT",
  jobId: "AGENTRELAY_JOB_ID",
  project: "AGENTRELAY_PROJECT",
  message: "AGENTRELAY_MESSAGE",
} as const;

/** Default time (ms) to let a hook run before it's killed, so a hung hook can't stall the relay loop. */
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/** A minimal view of the spawned child the notifier needs — satisfied by Node's ChildProcess. */
export interface HookChild {
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): unknown;
}

/** Spawns the hook command with the given env. Injected in tests; defaults to a shell child. */
export type HookSpawnFn = (command: string, env: Record<string, string | undefined>) => HookChild;

const defaultHookSpawn: HookSpawnFn = (command, env) => {
  const child: ChildProcess =
    process.platform === "win32"
      ? spawn("cmd", ["/c", command], { env, stdio: "ignore" })
      : spawn("sh", ["-c", command], { env, stdio: "ignore" });
  return child;
};

/**
 * Pure: builds the child environment for a hook invocation by layering the
 * event's `AGENTRELAY_*` fields onto a base env (defaults to `process.env` so
 * the hook inherits PATH etc.). Never mutates the base.
 */
export function buildHookEnv(
  payload: NotifyPayload,
  baseEnv: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  return {
    ...baseEnv,
    [HOOK_ENV_VARS.event]: payload.event,
    [HOOK_ENV_VARS.jobId]: payload.jobId,
    [HOOK_ENV_VARS.project]: payload.project,
    [HOOK_ENV_VARS.message]: payload.message,
  };
}

export interface ExecNotifierOptions {
  /** Shell command to run for each event (branch on `$AGENTRELAY_EVENT` inside it). */
  command: string;
  /**
   * Milliseconds to wait for the hook before killing it. Defaults to
   * {@link DEFAULT_HOOK_TIMEOUT_MS}; `0`/negative disables the timeout (wait
   * indefinitely). The timer is `unref`'d so it never keeps the process alive
   * on its own.
   */
  timeoutMs?: number;
  /** Base environment merged with the event vars. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injected for tests; defaults to a real shell child. */
  spawnFn?: HookSpawnFn;
  /** Called when the hook fails to spawn, errors, times out, or exits non-zero. */
  onError?: (error: unknown) => void;
}

/**
 * Returns a {@link Notifier} that runs {@link ExecNotifierOptions.command} once
 * per event. Failures (spawn error, non-zero exit, timeout) are reported via
 * `onError` but never thrown — a broken hook must not take down the relay loop,
 * exactly like the HTTP notifiers. The returned promise resolves when the hook
 * finishes or is killed, so callers that await it (`run`, the scheduler) can
 * treat it like any other notifier.
 */
export function createExecNotifier(options: ExecNotifierOptions): Notifier {
  const spawnFn = options.spawnFn ?? defaultHookSpawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error(`[agentrelay] Event hook failed: ${String(error)}`);
    });

  return (payload: NotifyPayload) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      let child: HookChild;
      try {
        child = spawnFn(options.command, buildHookEnv(payload, options.env));
      } catch (error) {
        // Synchronous spawn failure (e.g. missing shell) — report and move on.
        onError(error);
        done();
        return;
      }

      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          onError(new Error(`Event hook timed out after ${timeoutMs}ms`));
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore — best-effort kill
          }
          done();
        }, timeoutMs);
        // The hook is fire-and-forget; its timer must not keep the process alive.
        (timer as { unref?: () => void }).unref?.();
      }

      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        onError(error);
        done();
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        if (code !== null && code !== 0) {
          onError(new Error(`Event hook exited with code ${code}`));
        }
        done();
      });
    });
}

/**
 * Pure: resolves a hook timeout from a raw duration string (`"10s"`, `"500ms"`),
 * falling back to `fallback` when unset/blank/unparseable so a typo can't
 * silently disable the safety timeout.
 */
export function parseHookTimeoutMs(raw: string | undefined, fallback = DEFAULT_HOOK_TIMEOUT_MS): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const ms = parseDuration(trimmed);
  return ms === null ? fallback : ms;
}

/**
 * Builds an event-hook notifier from `AGENTRELAY_ON_EVENT` (the command).
 * `AGENTRELAY_ON_EVENT_TIMEOUT` optionally overrides the kill timeout (a
 * duration like `"5s"`). Returns null when the command is unset/blank so
 * callers can silently skip local hooks.
 */
export function execNotifierFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: Omit<ExecNotifierOptions, "command" | "env"> = {}
): Notifier | null {
  const command = env.AGENTRELAY_ON_EVENT?.trim();
  if (!command) return null;
  const timeoutMs = parseHookTimeoutMs(env.AGENTRELAY_ON_EVENT_TIMEOUT, options.timeoutMs);
  return createExecNotifier({ command, timeoutMs, env, spawnFn: options.spawnFn, onError: options.onError });
}
