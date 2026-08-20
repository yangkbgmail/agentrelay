import type { NextResume, RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_PENDING_MESSAGE, renderNext, renderNextJson } from "../src/next.js";

const NOW = Date.parse("2026-07-13T00:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "abcdef1234567890",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "waiting_for_reset",
    resetAt: at(90 * 60_000),
    createdAt: at(-1000),
    updatedAt: at(-1000),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function next(overrides: Partial<NextResume> = {}): NextResume {
  return {
    job: job(),
    dueInMs: 90 * 60_000,
    due: false,
    waitingBehind: 0,
    ...overrides,
  };
}

describe("renderNext", () => {
  it("shows the empty message when nothing is waiting", () => {
    expect(renderNext(null, { now: NOW })).toBe(NO_PENDING_MESSAGE);
  });

  it("shows the short id, project, countdown and absolute reset time", () => {
    const out = renderNext(next(), { now: NOW });
    expect(out).toContain("abcdef12");
    expect(out).toContain("demo");
    expect(out).toContain("resets in 1h 30m");
    expect(out).toContain(at(90 * 60_000));
  });

  it("says 'due now' once the reset time has passed", () => {
    const out = renderNext(next({ job: job({ resetAt: at(-1000) }), dueInMs: -1000, due: true }), { now: NOW });
    expect(out).toContain("due now");
    expect(out).not.toContain("resets in");
  });

  it("omits the 'more waiting' note when nothing is behind it", () => {
    expect(renderNext(next({ waitingBehind: 0 }), { now: NOW })).not.toContain("waiting behind");
  });

  it("uses singular/plural for the jobs waiting behind it", () => {
    expect(renderNext(next({ waitingBehind: 1 }), { now: NOW })).toContain("1 more job waiting behind it.");
    expect(renderNext(next({ waitingBehind: 3 }), { now: NOW })).toContain("3 more jobs waiting behind it.");
  });

  it("emits no ANSI codes when color is off", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(renderNext(next({ waitingBehind: 2 }), { now: NOW, color: false })).not.toMatch(/\x1b\[/);
  });
});

describe("renderNextJson", () => {
  it("produces valid JSON with storePath and a null next when idle", () => {
    const parsed = JSON.parse(renderNextJson(null, "/tmp/store.json", "2026-07-13T00:00:00.000Z"));
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-13T00:00:00.000Z");
    expect(parsed.next).toBeNull();
  });

  it("carries the full job plus derived due state", () => {
    const parsed = JSON.parse(renderNextJson(next({ due: true, dueInMs: -500 }), "/tmp/store.json"));
    expect(parsed.next.job.project).toBe("demo");
    expect(parsed.next.due).toBe(true);
    expect(parsed.next.dueInMs).toBe(-500);
    expect(parsed.next.waitingBehind).toBe(0);
  });

  it("omits the scope key entirely when no scope is passed (unscoped shape unchanged)", () => {
    const parsed = JSON.parse(renderNextJson(next(), "/tmp/store.json"));
    expect("scope" in parsed).toBe(false);
  });

  it("echoes an active scope so a consumer can tell the result was filtered", () => {
    const parsed = JSON.parse(
      renderNextJson(next(), "/tmp/store.json", "2026-07-13T00:00:00.000Z", { projects: ["web"] })
    );
    expect(parsed.scope).toEqual({ projects: ["web"] });
  });
});

describe("renderNext scope note", () => {
  it("appends a dim [scope: …] line when a scope is active", () => {
    const out = renderNext(next(), { now: NOW, scopeNote: "project=web" });
    expect(out).toContain("[scope: project=web]");
  });

  it("still shows the scope note when the filtered subset is empty", () => {
    const out = renderNext(null, { now: NOW, scopeNote: "tool=codex-cli" });
    expect(out).toContain(NO_PENDING_MESSAGE);
    expect(out).toContain("[scope: tool=codex-cli]");
  });

  it("adds nothing when no scope note is given", () => {
    expect(renderNext(next(), { now: NOW })).not.toContain("[scope:");
  });
});
