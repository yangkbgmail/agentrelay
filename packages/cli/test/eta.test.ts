import type { QueueEta } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { CAUGHT_UP_MESSAGE, renderEta, renderEtaJson, renderEtaWatchFrame } from "../src/eta.js";

// A fixed "now" so the watch-frame timestamp assertions are deterministic.
const NOW = Date.parse("2026-07-30T12:00:00.000Z");

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

describe("renderEtaWatchFrame", () => {
  it("prepends a live title with the store path, timestamp, and interval", () => {
    const out = renderEtaWatchFrame(eta(), "/tmp/jobs.json", 5000, NOW);
    const lines = out.split("\n");
    expect(lines[0]).toContain("agentrelay eta");
    expect(lines[0]).toContain("every 5s");
    expect(lines[0]).toContain("Ctrl-C to exit");
    // Metadata line: ISO timestamp (space-separated, trimmed to seconds) + store path.
    expect(lines[1]).toContain("2026-07-30 12:00:00Z");
    expect(lines[1]).toContain("/tmp/jobs.json");
    // Then a blank line, then the colored eta body (the "5h 0m" countdown is
    // bolded, so the phrase is split by ANSI codes — assert the parts).
    expect(lines[2]).toBe("");
    expect(out).toContain("Queue caught up in");
    expect(out).toContain("5h 0m");
  });

  it("renders the caught-up body and is always colored (live TTY view)", () => {
    const out = renderEtaWatchFrame(caughtUp(), "/tmp/jobs.json", 2000, NOW);
    expect(out).toContain(CAUGHT_UP_MESSAGE);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting escapes are present.
    expect(out).toMatch(/\x1b\[/);
  });
});
