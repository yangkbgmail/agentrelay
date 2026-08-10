import { describe, expect, it } from "vitest";
import { computeEtaByProject, computeQueueEta } from "./eta.js";
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
    status: "waiting_for_reset",
    resetAt: "2026-07-30T12:00:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-30T10:00:00.000Z");

describe("computeQueueEta", () => {
  it("reports caught-up on an empty queue", () => {
    expect(computeQueueEta([], NOW)).toEqual({
      waiting: 0,
      dueNow: 0,
      firstResetAt: null,
      lastResetAt: null,
      etaMs: null,
      spanMs: null,
      caughtUp: true,
    });
  });

  it("ignores jobs that are not waiting_for_reset", () => {
    const eta = computeQueueEta(
      [
        job({ status: "completed", resetAt: "2026-07-30T20:00:00.000Z" }),
        job({ status: "queued", resetAt: null }),
        job({ status: "resuming", resetAt: "2026-07-30T22:00:00.000Z" }),
        job({ status: "failed", resetAt: "2026-07-30T23:00:00.000Z" }),
      ],
      NOW
    );
    expect(eta.waiting).toBe(0);
    expect(eta.caughtUp).toBe(true);
  });

  it("skips waiting jobs whose resetAt is null or unparseable", () => {
    const eta = computeQueueEta(
      [job({ resetAt: null }), job({ resetAt: "not-a-date" }), job({ resetAt: "2026-07-30T14:00:00.000Z" })],
      NOW
    );
    expect(eta.waiting).toBe(1);
    expect(eta.lastResetAt).toBe("2026-07-30T14:00:00.000Z");
  });

  it("uses the LATEST reset as the catch-up moment (not the soonest)", () => {
    const eta = computeQueueEta(
      [
        job({ resetAt: "2026-07-30T11:00:00.000Z" }), // soonest
        job({ resetAt: "2026-07-30T15:00:00.000Z" }), // latest
        job({ resetAt: "2026-07-30T13:00:00.000Z" }),
      ],
      NOW
    );
    expect(eta.waiting).toBe(3);
    expect(eta.firstResetAt).toBe("2026-07-30T11:00:00.000Z");
    expect(eta.lastResetAt).toBe("2026-07-30T15:00:00.000Z");
    // ETA is measured to the latest reset: 15:00 - 10:00 = 5h.
    expect(eta.etaMs).toBe(5 * 60 * 60 * 1000);
    // Span from soonest to latest: 11:00 → 15:00 = 4h.
    expect(eta.spanMs).toBe(4 * 60 * 60 * 1000);
    expect(eta.caughtUp).toBe(false);
  });

  it("counts jobs already past due", () => {
    const eta = computeQueueEta(
      [
        job({ resetAt: "2026-07-30T09:00:00.000Z" }), // past
        job({ resetAt: "2026-07-30T10:00:00.000Z" }), // exactly now (due)
        job({ resetAt: "2026-07-30T12:00:00.000Z" }), // future
      ],
      NOW
    );
    expect(eta.dueNow).toBe(2);
    expect(eta.waiting).toBe(3);
  });

  it("returns a negative etaMs when even the last reset has passed", () => {
    const eta = computeQueueEta(
      [job({ resetAt: "2026-07-30T08:00:00.000Z" }), job({ resetAt: "2026-07-30T09:00:00.000Z" })],
      NOW
    );
    expect(eta.etaMs).toBe(-1 * 60 * 60 * 1000);
    expect(eta.dueNow).toBe(2);
  });

  it("has a zero span for a single waiting job", () => {
    const eta = computeQueueEta([job({ resetAt: "2026-07-30T13:00:00.000Z" })], NOW);
    expect(eta.waiting).toBe(1);
    expect(eta.spanMs).toBe(0);
    expect(eta.firstResetAt).toBe(eta.lastResetAt);
  });
});

describe("computeEtaByProject", () => {
  it("returns an empty list when nothing is waiting", () => {
    expect(computeEtaByProject([], NOW)).toEqual([]);
    expect(computeEtaByProject([job({ status: "completed", resetAt: "2026-07-30T20:00:00.000Z" })], NOW)).toEqual([]);
  });

  it("splits waiting jobs into one row per project", () => {
    const rows = computeEtaByProject(
      [
        job({ project: "web", resetAt: "2026-07-30T11:00:00.000Z" }),
        job({ project: "infra", resetAt: "2026-07-30T14:00:00.000Z" }),
      ],
      NOW
    );
    expect(rows).toHaveLength(2);
    const projects = rows.map((r) => r.project);
    expect(new Set(projects)).toEqual(new Set(["web", "infra"]));
  });

  it("computes each project's ETA from just its own jobs", () => {
    const rows = computeEtaByProject(
      [
        job({ project: "web", resetAt: "2026-07-30T11:00:00.000Z" }),
        job({ project: "web", resetAt: "2026-07-30T13:00:00.000Z" }),
        job({ project: "infra", resetAt: "2026-07-30T15:00:00.000Z" }),
      ],
      NOW
    );
    const web = rows.find((r) => r.project === "web");
    expect(web?.eta.waiting).toBe(2);
    // web's catch-up is its own latest reset (13:00), not infra's 15:00.
    expect(web?.eta.lastResetAt).toBe("2026-07-30T13:00:00.000Z");
    expect(web?.eta.etaMs).toBe(3 * 60 * 60 * 1000); // 13:00 - 10:00
    expect(web?.eta.spanMs).toBe(2 * 60 * 60 * 1000); // 11:00 → 13:00
  });

  it("orders soonest-caught-up first, then by project name", () => {
    const rows = computeEtaByProject(
      [
        job({ project: "infra", resetAt: "2026-07-30T15:00:00.000Z" }),
        job({ project: "web", resetAt: "2026-07-30T11:00:00.000Z" }),
        // Same lastResetAt as web (11:00) — name breaks the tie, so "api" precedes "web".
        job({ project: "api", resetAt: "2026-07-30T11:00:00.000Z" }),
      ],
      NOW
    );
    expect(rows.map((r) => r.project)).toEqual(["api", "web", "infra"]);
  });

  it("omits projects whose jobs are all active or terminal", () => {
    const rows = computeEtaByProject(
      [
        job({ project: "web", resetAt: "2026-07-30T12:00:00.000Z" }),
        job({ project: "done", status: "completed", resetAt: "2026-07-30T20:00:00.000Z" }),
        job({ project: "running", status: "resuming", resetAt: "2026-07-30T22:00:00.000Z" }),
      ],
      NOW
    );
    expect(rows.map((r) => r.project)).toEqual(["web"]);
  });

  it("agrees with computeQueueEta when only one project is present", () => {
    const jobs = [
      job({ project: "solo", resetAt: "2026-07-30T11:00:00.000Z" }),
      job({ project: "solo", resetAt: "2026-07-30T15:00:00.000Z" }),
    ];
    const rows = computeEtaByProject(jobs, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].eta).toEqual(computeQueueEta(jobs, NOW));
  });
});
