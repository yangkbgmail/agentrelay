import type { AttemptDistribution, RelayJob } from "@agentrelay/core";
import { summarizeAttempts } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_ATTEMPTS_MESSAGE, NO_SCOPE_MATCH_MESSAGE, renderAttempts, renderAttemptsJson } from "./attempts.js";

function dist(overrides: Partial<AttemptDistribution> = {}): AttemptDistribution {
  return {
    total: 0,
    totalAttempts: 0,
    retriedJobs: 0,
    neverResumed: 0,
    maxAttempts: 0,
    meanAttempts: null,
    buckets: [],
    ...overrides,
  };
}

let seq = 0;
function job(attempts: number, overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "proj",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("renderAttempts", () => {
  it("shows the empty-store hint when there are no jobs", () => {
    expect(renderAttempts(dist())).toBe(NO_ATTEMPTS_MESSAGE);
  });

  it("shows the no-match message when a scope filters everything out", () => {
    const out = renderAttempts(dist(), { scopeNote: "project=nope" });
    expect(out).toContain("scope: project=nope");
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
  });

  it("renders a header with totals and one row per observed bucket", () => {
    const d = dist({
      total: 4,
      totalAttempts: 5,
      retriedJobs: 1,
      neverResumed: 1,
      maxAttempts: 3,
      meanAttempts: 1.25,
      buckets: [
        { attempts: 0, count: 1 },
        { attempts: 1, count: 2 },
        { attempts: 3, count: 1 },
      ],
    });
    const out = renderAttempts(d);
    expect(out).toContain("4 job(s)");
    expect(out).toContain("5 total resume attempt(s)");
    expect(out).toContain("mean 1.25/job");
    expect(out).toContain("1 retried");
    expect(out).toContain("1 not yet resumed");
    // Special-cased bucket labels.
    expect(out).toContain("0 (not yet resumed)");
    expect(out).toContain("1 resume");
    expect(out).toContain("3 resumes");
    // The busiest bucket (count 2) gets the widest bar.
    expect(out).toContain("█");
  });

  it("gates ANSI color codes on the color flag", () => {
    const d = dist({
      total: 1,
      totalAttempts: 1,
      meanAttempts: 1,
      buckets: [{ attempts: 1, count: 1 }],
    });
    expect(renderAttempts(d, { color: false })).not.toContain("\x1b[");
    expect(renderAttempts(d, { color: true })).toContain("\x1b[");
  });

  it("matches summarizeAttempts end-to-end for a real job list", () => {
    const jobs = [job(0), job(1), job(1), job(4)];
    const d = summarizeAttempts(jobs);
    const out = renderAttempts(d);
    expect(out).toContain("4 job(s)");
    expect(out).toContain("6 total resume attempt(s)"); // 0+1+1+4
    expect(out).toContain("1 retried"); // only the attempts=4 job
    expect(out).toContain("4 resumes");
  });
});

describe("renderAttemptsJson", () => {
  it("emits the store path, scope, and full distribution", () => {
    const d = summarizeAttempts([job(1), job(2)]);
    const json = renderAttemptsJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-08-12T00:00:00.000Z",
      scope: { tools: ["claude-code"] },
      distribution: d,
    });
    const parsed = JSON.parse(json);
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.scope).toEqual({ tools: ["claude-code"] });
    expect(parsed.distribution.total).toBe(2);
    expect(parsed.distribution.buckets).toEqual([
      { attempts: 1, count: 1 },
      { attempts: 2, count: 1 },
    ]);
  });
});
