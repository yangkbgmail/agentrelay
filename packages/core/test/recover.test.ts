import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RelayQueue } from "../src/queue.js";
import { DEFAULT_STUCK_RESUMING_MS, selectStuckResumingJobs } from "../src/recover.js";
import type { RelayJob } from "../src/types.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

function job(overrides: Partial<RelayJob>): RelayJob {
  return {
    id: overrides.id ?? "id",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "resuming",
    resetAt: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

/** ISO string for `ms` before NOW. */
function agoIso(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

/** ISO string for `ms` after NOW (a clock-skewed, future-dated timestamp). */
function aheadIso(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

describe("selectStuckResumingJobs", () => {
  it("selects resuming jobs older than the threshold and ignores fresh ones", () => {
    const jobs = [
      job({ id: "old", updatedAt: agoIso(45 * 60_000) }), // 45m — stuck
      job({ id: "fresh", updatedAt: agoIso(2 * 60_000) }), // 2m — a live run
    ];
    const report = selectStuckResumingJobs(jobs, { nowMs: NOW });
    expect(report.stuckAfterMs).toBe(DEFAULT_STUCK_RESUMING_MS);
    expect(report.resuming).toBe(2);
    expect(report.stuck.map((j) => j.id)).toEqual(["old"]);
  });

  it("ignores non-resuming jobs entirely", () => {
    const jobs = [
      job({ id: "done", status: "completed", updatedAt: agoIso(10 * 60 * 60_000) }),
      job({ id: "waiting", status: "waiting_for_reset", updatedAt: agoIso(10 * 60 * 60_000) }),
      job({ id: "stuck", updatedAt: agoIso(60 * 60_000) }),
    ];
    const report = selectStuckResumingJobs(jobs, { nowMs: NOW });
    expect(report.total).toBe(3);
    expect(report.resuming).toBe(1);
    expect(report.stuck.map((j) => j.id)).toEqual(["stuck"]);
  });

  it("orders stuck jobs oldest-first", () => {
    const jobs = [
      job({ id: "b", updatedAt: agoIso(60 * 60_000) }),
      job({ id: "a", updatedAt: agoIso(3 * 60 * 60_000) }),
      job({ id: "c", updatedAt: agoIso(40 * 60_000) }),
    ];
    const report = selectStuckResumingJobs(jobs, { nowMs: NOW });
    expect(report.stuck.map((j) => j.id)).toEqual(["a", "b", "c"]);
  });

  it("treats an unparseable updatedAt as stuck (no live loop would write one)", () => {
    const jobs = [job({ id: "corrupt", updatedAt: "not-a-date" })];
    const report = selectStuckResumingJobs(jobs, { nowMs: NOW });
    expect(report.stuck.map((j) => j.id)).toEqual(["corrupt"]);
  });

  it("treats a future-dated updatedAt as stuck (clock skew, not a live run)", () => {
    // A backward wall-clock step between markResuming and recover leaves an
    // orphan dated ahead of now. A naive `now - updatedAt` scores this as a
    // negative age that slips under every threshold — it must be reclaimed.
    const jobs = [job({ id: "future", updatedAt: aheadIso(5 * 60_000) })];
    const report = selectStuckResumingJobs(jobs, { nowMs: NOW });
    expect(report.stuck.map((j) => j.id)).toEqual(["future"]);
  });

  it("reclaims a future-dated job even at stuckAfterMs 0 (contract: 0 = all)", () => {
    const jobs = [job({ id: "future", updatedAt: aheadIso(90 * 60_000) })];
    const report = selectStuckResumingJobs(jobs, { nowMs: NOW, stuckAfterMs: 0 });
    expect(report.stuck.map((j) => j.id)).toEqual(["future"]);
  });

  it("sorts future-dated / unparseable suspects ahead of merely-old jobs", () => {
    const jobs = [
      job({ id: "old", updatedAt: agoIso(3 * 60 * 60_000) }), // 3h old
      job({ id: "future", updatedAt: aheadIso(10 * 60_000) }), // clock-skewed
      job({ id: "corrupt", updatedAt: "not-a-date" }),
    ];
    const report = selectStuckResumingJobs(jobs, { nowMs: NOW });
    // Both suspects (ageKey -Infinity) sort before the finite-age "old" job.
    expect(report.stuck.map((j) => j.id).slice(-1)).toEqual(["old"]);
    expect(
      report.stuck
        .map((j) => j.id)
        .slice(0, 2)
        .sort()
    ).toEqual(["corrupt", "future"]);
  });

  it("with stuckAfterMs 0 selects every resuming job regardless of age", () => {
    const jobs = [
      job({ id: "just-now", updatedAt: agoIso(1_000) }),
      job({ id: "older", updatedAt: agoIso(5 * 60_000) }),
    ];
    const report = selectStuckResumingJobs(jobs, { nowMs: NOW, stuckAfterMs: 0 });
    expect(report.stuckAfterMs).toBe(0);
    expect(report.stuck.map((j) => j.id).sort()).toEqual(["just-now", "older"]);
  });

  it("returns an empty selection when nothing is stuck", () => {
    const report = selectStuckResumingJobs([job({ id: "fresh", updatedAt: agoIso(1_000) })], { nowMs: NOW });
    expect(report.stuck).toEqual([]);
    expect(report.resuming).toBe(1);
  });
});

describe("RelayQueue.recoverResuming", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-recover-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("requeues a stuck resuming job to run now while preserving attempts", () => {
    const queue = new RelayQueue(join(dir, "jobs.json"));
    const created = queue.enqueue({ project: "demo", tool: "claude-code", command: ["claude"], cwd: "/tmp" });
    queue.markResuming(created.id); // attempts → 1, status → resuming
    expect(queue.getById(created.id)?.attempts).toBe(1);

    const at = "2026-08-15T12:00:00.000Z";
    expect(queue.recoverResuming(created.id, at)).toBe(true);

    const recovered = queue.getById(created.id);
    expect(recovered?.status).toBe("waiting_for_reset");
    expect(recovered?.resetAt).toBe(at);
    expect(recovered?.attempts).toBe(1); // preserved — the crashed attempt still counts
    expect(recovered?.lastError).toContain("interrupted resume");
    // Immediately due for the next tick.
    expect(queue.listDue(new Date(Date.parse(at) + 1)).map((j) => j.id)).toContain(created.id);
    queue.close();
  });

  it("is a no-op returning false when the job is not resuming", () => {
    const queue = new RelayQueue(join(dir, "jobs.json"));
    const created = queue.enqueue({ project: "demo", tool: "claude-code", command: ["claude"], cwd: "/tmp" });
    // Still `queued`, not `resuming`.
    expect(queue.recoverResuming(created.id)).toBe(false);
    expect(queue.getById(created.id)?.status).toBe("queued");
    expect(queue.recoverResuming("no-such-id")).toBe(false);
    queue.close();
  });
});
