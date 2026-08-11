import type { QueueEta } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { CAUGHT_UP_MESSAGE, renderEta, renderEtaJson, renderEtaWatchFrame } from "../src/eta.js";

function caughtUp(): QueueEta {
  return {
    waiting: 0,
    dueNow: 0,
    firstResetAt: null,
    lastResetAt: null,
    etaMs: null,
    spanMs: null,
    caughtUp: true,
  };
}

function eta(overrides: Partial<QueueEta> = {}): QueueEta {
  return {
    waiting: 3,
    dueNow: 0,
    firstResetAt: "2026-07-30T11:00:00.000Z",
    lastResetAt: "2026-07-30T15:00:00.000Z",
    etaMs: 5 * 60 * 60 * 1000,
    spanMs: 4 * 60 * 60 * 1000,
    caughtUp: false,
    ...overrides,
  };
}

describe("renderEta", () => {
  it("shows the caught-up message when nothing is waiting", () => {
    expect(renderEta(caughtUp())).toBe(CAUGHT_UP_MESSAGE);
  });

  it("reports the countdown to the latest reset, the span, and the waiting count", () => {
    const out = renderEta(eta());
    expect(out).toContain("Queue caught up in 5h 0m");
    expect(out).toContain("3 jobs waiting");
    expect(out).toContain("last resets at 2026-07-30T15:00:00.000Z");
    expect(out).toContain("spread over 4h 0m");
  });

  it("uses singular for a single waiting job and omits a zero span", () => {
    const out = renderEta(eta({ waiting: 1, spanMs: 0 }));
    expect(out).toContain("1 job waiting");
    expect(out).not.toContain("spread over");
  });

  it("phrases an already-due queue as 'now (all due)' instead of a dash", () => {
    const out = renderEta(eta({ etaMs: -1000, dueNow: 3 }));
    expect(out).toContain("now (all due)");
    expect(out).toContain("3 due now");
    expect(out).not.toContain("caught up in -");
  });

  it("emits no ANSI codes when color is off", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(renderEta(eta(), { color: false })).not.toMatch(/\x1b\[/);
  });
});

describe("renderEtaWatchFrame", () => {
  const now = Date.parse("2026-07-30T10:00:00.000Z");

  it("wraps the ETA in a live title/meta banner with the interval and store path", () => {
    const frame = renderEtaWatchFrame(eta(), "/tmp/store.json", 2000, now);
    expect(frame).toContain("agentrelay eta");
    expect(frame).toContain("(live, every 2s — Ctrl-C to exit)");
    expect(frame).toContain("2026-07-30 10:00:00Z");
    expect(frame).toContain("/tmp/store.json");
    // Body is the colored one-line ETA (the duration is wrapped in ANSI bold, so
    // the head and the value are asserted separately).
    expect(frame).toContain("Queue caught up in");
    expect(frame).toContain("5h 0m");
  });

  it("rounds the interval to whole seconds in the banner", () => {
    const frame = renderEtaWatchFrame(eta(), "/tmp/store.json", 5000, now);
    expect(frame).toContain("every 5s");
  });

  it("renders the caught-up body when nothing is waiting", () => {
    const frame = renderEtaWatchFrame(caughtUp(), "/tmp/store.json", 2000, now);
    expect(frame).toContain(CAUGHT_UP_MESSAGE);
  });

  it("emits ANSI codes (the live frame is always colored)", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI escapes are present.
    expect(renderEtaWatchFrame(eta(), "/tmp/store.json", 2000, now)).toMatch(/\x1b\[/);
  });
});

describe("renderEtaJson", () => {
  it("produces valid JSON with storePath and the caught-up eta", () => {
    const parsed = JSON.parse(renderEtaJson(caughtUp(), "/tmp/store.json", "2026-07-30T10:00:00.000Z"));
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.eta.caughtUp).toBe(true);
    expect(parsed.eta.lastResetAt).toBeNull();
  });

  it("carries the full eta shape when jobs are waiting", () => {
    const parsed = JSON.parse(renderEtaJson(eta({ dueNow: 1 }), "/tmp/store.json"));
    expect(parsed.eta.waiting).toBe(3);
    expect(parsed.eta.dueNow).toBe(1);
    expect(parsed.eta.etaMs).toBe(5 * 60 * 60 * 1000);
    expect(parsed.eta.lastResetAt).toBe("2026-07-30T15:00:00.000Z");
  });
});
