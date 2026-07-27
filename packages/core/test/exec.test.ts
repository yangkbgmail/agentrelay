import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHookEnv,
  createExecNotifier,
  DEFAULT_HOOK_TIMEOUT_MS,
  execNotifierFromEnv,
  HOOK_ENV_VARS,
  type HookChild,
  parseHookTimeoutMs,
} from "../src/exec.js";
import type { NotifyPayload } from "../src/types.js";

const payload: NotifyPayload = {
  jobId: "job-123",
  project: "myproj",
  event: "resumed",
  message: "Resuming job for myproj (attempt 2)",
};

/** A controllable stand-in for a spawned child process. */
class FakeChild implements HookChild {
  closeListeners: Array<(code: number | null) => void> = [];
  errorListeners: Array<(err: Error) => void> = [];
  killed: NodeJS.Signals | number | undefined;

  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "close" | "error", listener: (arg: never) => void): unknown {
    if (event === "close") this.closeListeners.push(listener as (code: number | null) => void);
    else this.errorListeners.push(listener as (err: Error) => void);
    return this;
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = signal;
    return true;
  }
  emitClose(code: number | null): void {
    for (const l of this.closeListeners) l(code);
  }
  emitError(err: Error): void {
    for (const l of this.errorListeners) l(err);
  }
}

describe("buildHookEnv", () => {
  it("layers the event fields onto the base env", () => {
    const env = buildHookEnv(payload, { PATH: "/usr/bin", EXISTING: "keep" });
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      EXISTING: "keep",
      [HOOK_ENV_VARS.event]: "resumed",
      [HOOK_ENV_VARS.jobId]: "job-123",
      [HOOK_ENV_VARS.project]: "myproj",
      [HOOK_ENV_VARS.message]: "Resuming job for myproj (attempt 2)",
    });
  });

  it("does not mutate the base env", () => {
    const base = { PATH: "/usr/bin" };
    buildHookEnv(payload, base);
    expect(base).toEqual({ PATH: "/usr/bin" });
  });
});

describe("createExecNotifier", () => {
  it("spawns the command with the event env and resolves on a clean exit", async () => {
    let seenCommand: string | undefined;
    let seenEnv: Record<string, string | undefined> | undefined;
    const child = new FakeChild();
    const onError = vi.fn();
    const notify = createExecNotifier({
      command: "notify-send hi",
      env: { PATH: "/usr/bin" },
      onError,
      spawnFn: (command, env) => {
        seenCommand = command;
        seenEnv = env;
        return child;
      },
    });

    const promise = notify(payload);
    child.emitClose(0);
    await promise;

    expect(seenCommand).toBe("notify-send hi");
    expect(seenEnv?.[HOOK_ENV_VARS.event]).toBe("resumed");
    expect(seenEnv?.[HOOK_ENV_VARS.project]).toBe("myproj");
    expect(seenEnv?.PATH).toBe("/usr/bin");
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a non-zero exit through onError but still resolves", async () => {
    const child = new FakeChild();
    const onError = vi.fn();
    const notify = createExecNotifier({ command: "false", onError, spawnFn: () => child });

    const promise = notify(payload);
    child.emitClose(3);
    await promise;

    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toMatch(/exited with code 3/);
  });

  it("reports a spawn 'error' event and resolves", async () => {
    const child = new FakeChild();
    const onError = vi.fn();
    const notify = createExecNotifier({ command: "missing-bin", onError, spawnFn: () => child });

    const promise = notify(payload);
    child.emitError(new Error("ENOENT"));
    await promise;

    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toMatch(/ENOENT/);
  });

  it("never throws when the spawn call itself fails synchronously", async () => {
    const onError = vi.fn();
    const notify = createExecNotifier({
      command: "boom",
      onError,
      spawnFn: () => {
        throw new Error("no shell");
      },
    });

    await expect(notify(payload)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toMatch(/no shell/);
  });

  it("kills a hook that overruns the timeout and resolves", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const onError = vi.fn();
      const notify = createExecNotifier({ command: "sleep 60", timeoutMs: 1000, onError, spawnFn: () => child });

      const promise = notify(payload);
      vi.advanceTimersByTime(1000);
      await promise;

      expect(child.killed).toBe("SIGKILL");
      expect(onError).toHaveBeenCalledTimes(1);
      expect(String(onError.mock.calls[0][0])).toMatch(/timed out after 1000ms/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not arm a timeout when timeoutMs <= 0", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const onError = vi.fn();
      const notify = createExecNotifier({ command: "long", timeoutMs: 0, onError, spawnFn: () => child });

      const promise = notify(payload);
      vi.advanceTimersByTime(1_000_000);
      // Still pending — no timeout fired.
      child.emitClose(0);
      await promise;

      expect(child.killed).toBeUndefined();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("parseHookTimeoutMs", () => {
  it("falls back to the default when unset or blank", () => {
    expect(parseHookTimeoutMs(undefined)).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    expect(parseHookTimeoutMs("   ")).toBe(DEFAULT_HOOK_TIMEOUT_MS);
  });

  it("parses duration strings", () => {
    expect(parseHookTimeoutMs("5s")).toBe(5000);
    expect(parseHookTimeoutMs("500ms")).toBe(500);
  });

  it("falls back on an unparseable value instead of silently disabling the timeout", () => {
    expect(parseHookTimeoutMs("nonsense")).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    expect(parseHookTimeoutMs("later", 42)).toBe(42);
  });
});

describe("execNotifierFromEnv", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when AGENTRELAY_ON_EVENT is unset or blank", () => {
    expect(execNotifierFromEnv({})).toBeNull();
    expect(execNotifierFromEnv({ AGENTRELAY_ON_EVENT: "   " })).toBeNull();
  });

  it("builds a notifier that runs the configured command", async () => {
    let seenCommand: string | undefined;
    const child = new FakeChild();
    const notify = execNotifierFromEnv(
      { AGENTRELAY_ON_EVENT: "log-event" },
      {
        spawnFn: (command) => {
          seenCommand = command;
          return child;
        },
      }
    );
    expect(notify).not.toBeNull();

    const promise = notify!(payload);
    child.emitClose(0);
    await promise;
    expect(seenCommand).toBe("log-event");
  });

  it("honors AGENTRELAY_ON_EVENT_TIMEOUT", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const onError = vi.fn();
    const notify = execNotifierFromEnv(
      { AGENTRELAY_ON_EVENT: "sleep 9", AGENTRELAY_ON_EVENT_TIMEOUT: "2s" },
      { spawnFn: () => child, onError }
    );

    const promise = notify!(payload);
    vi.advanceTimersByTime(2000);
    await promise;

    expect(child.killed).toBe("SIGKILL");
    expect(String(onError.mock.calls[0][0])).toMatch(/timed out after 2000ms/);
  });
});
