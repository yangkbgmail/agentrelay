import type { NextResume, RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_PENDING_MESSAGE, NO_SCOPED_PENDING_MESSAGE, renderNext, renderNextJson } from "../src/next.js";

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

  it("shows the scoped empty message when a filter is active but nothing matches", () => {
    expect(renderNext(null, { now: NOW, scopeNote: "project=demo" })).toBe(NO_SCOPED_PENDING_MESSAGE);
    // Without a scope note it falls back to the plain empty message.
    expect(renderNext(null, { now: NOW })).toBe(NO_PENDING_MESSAGE);
  });

  it("appends a trailing scope line when a filter is active and a job is found", () => {
    const out = renderNext(next(), { now: NOW, scopeNote: "tool=claude-code project=demo" });
    expect(out).toContain("scope: tool=claude-code project=demo");
    // The scope line comes after the job line and any "waiting behind" note.
    const lines = out.split("\n");
    expect(lines[lines.length - 1]).toContain("scope:");
  });

  it("keeps the scope line after the 'waiting behind' note", () => {
    const out = renderNext(next({ waitingBehind: 2 }), { now: NOW, scopeNote: "tool=codex-cli" });
    const lines = out.split("\n");
    expect(lines[1]).toContain("2 more jobs waiting behind it.");
    expect(lines[2]).toContain("scope: tool=codex-cli");
  });

  it("omits the scope line entirely when no filter is active", () => {
    expect(renderNext(next(), { now: NOW })).not.toContain("scope:");
  });
});

describe("renderNextJson", () => {
  it("produces valid JSON with storePath and a null next when idle", () => {
    const parsed = JSON.parse(renderNextJson(null, "/tmp/store.json", { generatedAt: "2026-07-13T00:00:00.000Z" }));
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

  it("omits the scope field when no filter is active", () => {
    const parsed = JSON.parse(renderNextJson(next(), "/tmp/store.json"));
    expect(parsed.scope).toBeUndefined();
  });

  it("echoes the active scope so a scoped no-match is distinguishable", () => {
    const parsed = JSON.parse(
      renderNextJson(null, "/tmp/store.json", { scope: { tools: ["claude-code"], projects: ["demo"] } })
    );
    expect(parsed.next).toBeNull();
    expect(parsed.scope).toEqual({ tools: ["claude-code"], projects: ["demo"] });
  });
});
