import { describe, expect, it } from "vitest";
import { summarizeProjects } from "./projects.js";
import type { RelayJob } from "./types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("summarizeProjects", () => {
  it("returns an empty shape for no jobs", () => {
    expect(summarizeProjects([])).toEqual({ total: 0, projectCount: 0, projects: [] });
  });

  it("groups jobs by project and counts active vs terminal", () => {
    const summary = summarizeProjects([
      job({ project: "alpha", status: "completed" }),
      job({ project: "alpha", status: "queued" }),
      job({ project: "beta", status: "failed" }),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.projectCount).toBe(2);

    const alpha = summary.projects.find((p) => p.project === "alpha");
    const beta = summary.projects.find((p) => p.project === "beta");
    expect(alpha).toMatchObject({ total: 2, active: 1, terminal: 1, waiting: 0 });
    expect(beta).toMatchObject({ total: 1, active: 0, terminal: 1, waiting: 0 });
  });

  it("classifies each status as active or terminal correctly", () => {
    const summary = summarizeProjects([
      job({ project: "p", status: "queued" }),
      job({ project: "p", status: "waiting_for_reset" }),
      job({ project: "p", status: "resuming" }),
      job({ project: "p", status: "completed" }),
      job({ project: "p", status: "failed" }),
      job({ project: "p", status: "cancelled" }),
    ]);
    const p = summary.projects[0];
    expect(p.total).toBe(6);
    expect(p.active).toBe(3); // queued + waiting_for_reset + resuming
    expect(p.terminal).toBe(3); // completed + failed + cancelled
    expect(p.waiting).toBe(1); // only waiting_for_reset
  });

  it("picks the earliest resetAt among waiting jobs as nextResetAt", () => {
    const summary = summarizeProjects([
      job({ project: "p", status: "waiting_for_reset", resetAt: "2026-07-13T18:00:00.000Z" }),
      job({ project: "p", status: "waiting_for_reset", resetAt: "2026-07-13T15:00:00.000Z" }),
      // a resetAt on a non-waiting job must not count
      job({ project: "p", status: "resuming", resetAt: "2026-07-13T09:00:00.000Z" }),
    ]);
    expect(summary.projects[0].nextResetAt).toBe("2026-07-13T15:00:00.000Z");
  });

  it("leaves nextResetAt null when no job waits (or waiting jobs lack a resetAt)", () => {
    const summary = summarizeProjects([
      job({ project: "p", status: "completed" }),
      job({ project: "p", status: "waiting_for_reset", resetAt: null }),
    ]);
    expect(summary.projects[0].nextResetAt).toBeNull();
    expect(summary.projects[0].waiting).toBe(1);
  });

  it("tracks the most recent updatedAt as lastActivityAt", () => {
    const summary = summarizeProjects([
      job({ project: "p", updatedAt: "2026-07-13T01:00:00.000Z" }),
      job({ project: "p", updatedAt: "2026-07-13T05:00:00.000Z" }),
      job({ project: "p", updatedAt: "2026-07-13T03:00:00.000Z" }),
    ]);
    expect(summary.projects[0].lastActivityAt).toBe("2026-07-13T05:00:00.000Z");
  });

  it("ranks by active desc, then total desc, then name asc", () => {
    const summary = summarizeProjects([
      // zebra: 1 active, 3 total
      job({ project: "zebra", status: "queued" }),
      job({ project: "zebra", status: "completed" }),
      job({ project: "zebra", status: "completed" }),
      // alpha: 2 active, 2 total
      job({ project: "alpha", status: "queued" }),
      job({ project: "alpha", status: "resuming" }),
      // yankee: 1 active, 1 total (ties zebra on active, loses on total)
      job({ project: "yankee", status: "queued" }),
      // beta: 1 active, 1 total (ties yankee fully → name asc)
      job({ project: "beta", status: "queued" }),
    ]);
    expect(summary.projects.map((p) => p.project)).toEqual(["alpha", "zebra", "beta", "yankee"]);
  });
});
