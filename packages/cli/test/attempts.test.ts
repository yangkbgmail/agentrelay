import type { RelayJob } from "@agentrelay/core";
import { summarizeAttempts } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_ATTEMPTS_MESSAGE, NO_SCOPE_MATCH_MESSAGE, renderAttempts, renderAttemptsJson } from "../src/attempts.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `abcdef${seq}`,
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("renderAttempts", () => {
  it("shows the onboarding message for an empty store", () => {
    expect(renderAttempts(summarizeAttempts([]))).toBe(NO_ATTEMPTS_MESSAGE);
  });

  it("shows the no-match message for an empty scoped subset", () => {
    const out = renderAttempts(summarizeAttempts([]), { scopeNote: "project=web" });
    expect(out).toContain("scope: project=web");
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
  });

  it("renders a header with totals and one histogram row per attempt count", () => {
    const summary = summarizeAttempts([job({ attempts: 0 }), job({ attempts: 1 }), job({ attempts: 1 })]);
    const out = renderAttempts(summary);
    expect(out).toContain("3 job(s)");
    expect(out).toContain("2 total attempt(s)");
    expect(out).toContain("avg 0.7");
    expect(out).toContain("0 retried"); // attempts 0,1,1 — none reach >= 2
    expect(out).toContain("1 not yet resumed");
    expect(out).toContain("ATTEMPTS");
    // Two distinct attempt values (0 and 1) -> two histogram rows, both nonzero.
    const bars = out.split("\n").filter((l) => l.includes("█"));
    expect(bars.length).toBe(2);
  });

  it("flags jobs at or past a finite retry ceiling", () => {
    const summary = summarizeAttempts([job({ attempts: 5 }), job({ attempts: 6 }), job({ attempts: 1 })], {
      maxAttempts: 5,
    });
    const out = renderAttempts(summary);
    expect(out).toContain("at ceiling");
    expect(out).toContain("2 job(s) at or past the retry ceiling (maxAttempts=5)");
  });

  it("notes the ceiling was set but unreached when nothing is at it", () => {
    const summary = summarizeAttempts([job({ attempts: 1 }), job({ attempts: 2 })], { maxAttempts: 5 });
    const out = renderAttempts(summary);
    expect(out).toContain("Retry ceiling maxAttempts=5; no job has reached it");
    expect(out).not.toContain("at ceiling");
  });

  it("omits ceiling lines entirely when no ceiling is supplied", () => {
    const out = renderAttempts(summarizeAttempts([job({ attempts: 3 })]));
    expect(out).not.toContain("ceiling");
  });

  it("gates ANSI color codes behind the color option", () => {
    const summary = summarizeAttempts([job({ attempts: 5 })], { maxAttempts: 5 });
    expect(renderAttempts(summary, { color: false })).not.toContain("\x1b[");
    expect(renderAttempts(summary, { color: true })).toContain("\x1b[");
  });
});

describe("renderAttemptsJson", () => {
  it("emits the standard envelope with the summary", () => {
    const summary = summarizeAttempts([job({ attempts: 2 })], { maxAttempts: 5 });
    const json = JSON.parse(
      renderAttemptsJson({
        storePath: "/tmp/jobs.json",
        generatedAt: "2026-07-12T12:00:00.000Z",
        scope: { statuses: ["completed"] },
        summary,
      })
    );
    expect(json.storePath).toBe("/tmp/jobs.json");
    expect(json.generatedAt).toBe("2026-07-12T12:00:00.000Z");
    expect(json.scope).toEqual({ statuses: ["completed"] });
    expect(json.summary.ceiling).toBe(5);
    expect(json.summary.buckets).toEqual([{ attempts: 2, count: 1, jobIds: [summary.buckets[0].jobIds[0]] }]);
  });
});
