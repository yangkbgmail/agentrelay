import type { QueueEta } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_PENDING_MESSAGE, renderEta, renderEtaJson } from "../src/eta.js";

const NOW = Date.parse("2026-07-13T00:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function eta(overrides: Partial<QueueEta> = {}): QueueEta {
  return {
    waitingCount: 3,
    firstResetAt: at(60 * 60_000),
    firstDueInMs: 60 * 60_000,
    lastResetAt: at(180 * 60_000),
    lastDueInMs: 180 * 60_000,
    dueNow: 0,
    allDue: false,
    ...overrides,
  };
}

describe("renderEta", () => {
  it("shows the empty message when nothing is waiting", () => {
    expect(renderEta(null, { now: NOW })).toBe(NO_PENDING_MESSAGE);
  });

  it("counts down to the last reset and shows the waiting total", () => {
    const out = renderEta(eta(), { now: NOW });
    expect(out).toContain("all clear in 3h");
    expect(out).toContain("3 jobs waiting");
    expect(out).toContain(at(180 * 60_000));
  });

  it("uses singular for a single waiting job", () => {
    const out = renderEta(eta({ waitingCount: 1 }), { now: NOW });
    expect(out).toContain("1 job waiting");
  });

  it("says 'all clear' once every waiting job is due", () => {
    const out = renderEta(eta({ allDue: true, dueNow: 3, lastDueInMs: -1000 }), { now: NOW });
    expect(out).toContain("all clear");
    expect(out).toContain("3 jobs due now");
    expect(out).not.toContain("all clear in");
  });

  it("notes how many are already due while others still pend", () => {
    const out = renderEta(eta({ dueNow: 2 }), { now: NOW });
    expect(out).toContain("all clear in");
    expect(out).toContain("2 of them due now");
  });

  it("omits the due-now note when none are due yet", () => {
    expect(renderEta(eta({ dueNow: 0 }), { now: NOW })).not.toContain("due now");
  });

  it("emits no ANSI codes when color is off", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(renderEta(eta({ dueNow: 1 }), { now: NOW, color: false })).not.toMatch(/\x1b\[/);
  });
});

describe("renderEtaJson", () => {
  it("produces valid JSON with storePath and a null eta when idle", () => {
    const parsed = JSON.parse(renderEtaJson(null, "/tmp/store.json", "2026-07-13T00:00:00.000Z"));
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-13T00:00:00.000Z");
    expect(parsed.eta).toBeNull();
  });

  it("carries the forecast window and due counts", () => {
    const parsed = JSON.parse(renderEtaJson(eta({ dueNow: 1 }), "/tmp/store.json"));
    expect(parsed.eta.waitingCount).toBe(3);
    expect(parsed.eta.firstResetAt).toBe(at(60 * 60_000));
    expect(parsed.eta.lastResetAt).toBe(at(180 * 60_000));
    expect(parsed.eta.dueNow).toBe(1);
    expect(parsed.eta.allDue).toBe(false);
  });
});
