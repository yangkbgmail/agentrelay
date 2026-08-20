import type { QueueEta } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { CAUGHT_UP_MESSAGE, renderEta, renderEtaJson } from "../src/eta.js";

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

  it("omits the scope key entirely when no scope is passed (unscoped shape unchanged)", () => {
    const parsed = JSON.parse(renderEtaJson(eta(), "/tmp/store.json"));
    expect("scope" in parsed).toBe(false);
  });

  it("echoes an active scope so a consumer can tell the result was filtered", () => {
    const parsed = JSON.parse(
      renderEtaJson(eta(), "/tmp/store.json", "2026-07-30T10:00:00.000Z", { tools: ["codex-cli"] })
    );
    expect(parsed.scope).toEqual({ tools: ["codex-cli"] });
  });
});

describe("renderEta scope note", () => {
  it("appends a dim [scope: …] line when a scope is active", () => {
    const out = renderEta(eta(), { scopeNote: "tool=codex-cli" });
    expect(out).toContain("[scope: tool=codex-cli]");
  });

  it("still shows the scope note on a caught-up (empty subset) report", () => {
    const out = renderEta(caughtUp(), { scopeNote: "project=web" });
    expect(out).toContain(CAUGHT_UP_MESSAGE);
    expect(out).toContain("[scope: project=web]");
  });

  it("adds nothing when no scope note is given", () => {
    expect(renderEta(eta())).not.toContain("[scope:");
  });
});
