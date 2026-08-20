import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  FORWARDED_SIGNALS,
  type ForwardedSignal,
  forwardOne,
  forwardSignals,
  type SignalTarget,
  signalExitCode,
} from "../src/signals.js";

/**
 * A minimal fake child that records `kill` invocations without spawning a
 * process. Matches the {@link SignalTarget} shape. `pid` and `killed` default
 * to the "child is alive" values; individual tests flip them to exercise the
 * defensive paths in the forwarder.
 */
function makeFakeChild(overrides: Partial<SignalTarget> = {}): {
  target: SignalTarget;
  kill: ReturnType<typeof vi.fn>;
} {
  const kill = vi.fn(() => true);
  // Preserve an explicit `pid: undefined` — we spell it out with an
  // "in" check because `??` and `||` both collapse undefined to the default.
  const pid = "pid" in overrides ? overrides.pid : 12345;
  const target: SignalTarget = {
    pid,
    killed: overrides.killed ?? false,
    kill: overrides.kill ?? kill,
  };
  return { target, kill };
}

describe("signalExitCode", () => {
  it("maps each forwarded signal to POSIX 128 + signum", () => {
    expect(signalExitCode("SIGHUP")).toBe(129);
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGTERM")).toBe(143);
  });

  it("falls back to 1 for any signal we don't explicitly forward", () => {
    // We deliberately don't forward these, so we shouldn't pretend to know
    // their shell-level exit code either — a generic failure is safer than
    // fabricating a plausible-looking number.
    expect(signalExitCode("SIGUSR1")).toBe(1);
    expect(signalExitCode("SIGKILL")).toBe(1);
    expect(signalExitCode("nonsense")).toBe(1);
  });
});

describe("forwardOne", () => {
  it("delivers the signal via child.kill when the child is alive", () => {
    const { target, kill } = makeFakeChild();
    const delivered = forwardOne(target, "SIGINT");
    expect(delivered).toBe(true);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith("SIGINT");
  });

  it("skips the forward when the child has no pid yet (spawn failure)", () => {
    // A synchronous spawn failure hands us back a ChildProcess with no pid.
    // Calling kill on it would throw ERR_INVALID_ARG_TYPE — we skip instead.
    const { target, kill } = makeFakeChild({ pid: undefined });
    expect(forwardOne(target, "SIGTERM")).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("skips the forward when the child is already killed", () => {
    // Node flips `killed` to true after a successful signal, so a second
    // forward for the same signal would be a wasted (and racy) syscall.
    const { target, kill } = makeFakeChild({ killed: true });
    expect(forwardOne(target, "SIGHUP")).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("swallows kill() failures instead of crashing the wrapper", () => {
    // ESRCH ("no such process") is the common one — child reaped between the
    // forwarder queuing the signal and the syscall firing. A dying wrapper is
    // not a place to add a second failure mode.
    const target: SignalTarget = {
      pid: 12345,
      killed: false,
      kill: () => {
        throw new Error("kill ESRCH");
      },
    };
    expect(() => forwardOne(target, "SIGINT")).not.toThrow();
    expect(forwardOne(target, "SIGINT")).toBe(false);
  });
});

describe("forwardSignals", () => {
  it("installs one listener per forwarded signal on the host", () => {
    const host = new EventEmitter();
    const { target } = makeFakeChild();
    const dispose = forwardSignals(host, target);
    for (const signal of FORWARDED_SIGNALS) {
      expect(host.listenerCount(signal)).toBe(1);
    }
    dispose();
  });

  it("forwards each received signal to the child by name", () => {
    const host = new EventEmitter();
    const { target, kill } = makeFakeChild();
    const dispose = forwardSignals(host, target);

    // Emit each signal in turn and assert the exact signal name propagates —
    // we're forwarding, not translating.
    for (const signal of FORWARDED_SIGNALS) {
      host.emit(signal);
    }

    const seen = kill.mock.calls.map((call) => call[0]) as ForwardedSignal[];
    expect(seen).toEqual([...FORWARDED_SIGNALS]);
    dispose();
  });

  it("removes every listener it installed when dispose is called", () => {
    const host = new EventEmitter();
    const { target, kill } = makeFakeChild();
    const dispose = forwardSignals(host, target);
    dispose();

    for (const signal of FORWARDED_SIGNALS) {
      expect(host.listenerCount(signal)).toBe(0);
      host.emit(signal); // a stray post-dispose signal must not reach the child
    }
    expect(kill).not.toHaveBeenCalled();
  });

  it("is idempotent — a second dispose is a safe no-op", () => {
    // The wrapper resolves the run promise on both `close` and `error`, and
    // early-return paths could invoke dispose twice. Doing so must not remove
    // some *other* listener that happens to be attached to the same signal.
    const host = new EventEmitter();
    const stranger = vi.fn();
    host.on("SIGINT", stranger);
    const { target } = makeFakeChild();

    const dispose = forwardSignals(host, target);
    expect(host.listenerCount("SIGINT")).toBe(2); // stranger + forwarder

    dispose();
    expect(host.listenerCount("SIGINT")).toBe(1); // only stranger remains

    dispose(); // second call: no-op
    expect(host.listenerCount("SIGINT")).toBe(1);

    host.emit("SIGINT");
    expect(stranger).toHaveBeenCalledTimes(1);
  });

  it("stacks safely alongside listeners installed before it", () => {
    // The daemon watch loop also attaches SIGINT/SIGTERM handlers. Installing
    // ours must not remove theirs, and disposing ours must not remove theirs.
    const host = new EventEmitter();
    const preexisting = vi.fn();
    host.on("SIGTERM", preexisting);

    const { target, kill } = makeFakeChild();
    const dispose = forwardSignals(host, target);

    host.emit("SIGTERM");
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(preexisting).toHaveBeenCalledTimes(1);

    dispose();
    expect(host.listenerCount("SIGTERM")).toBe(1);
    host.emit("SIGTERM");
    expect(preexisting).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledTimes(1); // still just the one pre-dispose call
  });

  it("survives a child that transitions to killed mid-run", () => {
    // Simulates the wrapped agent exiting on its own between two received
    // signals: the first forward succeeds, then Node flips `killed`, and the
    // second forward should skip cleanly rather than crash.
    const state = { killed: false };
    const kill = vi.fn(() => {
      state.killed = true;
      return true;
    });
    const target: SignalTarget = {
      pid: 12345,
      get killed() {
        return state.killed;
      },
      kill,
    };

    const host = new EventEmitter();
    const dispose = forwardSignals(host, target);
    host.emit("SIGINT"); // first pass: alive → delivered, flips killed
    host.emit("SIGINT"); // second pass: killed → skipped, no throw
    expect(kill).toHaveBeenCalledTimes(1);
    dispose();
  });
});
