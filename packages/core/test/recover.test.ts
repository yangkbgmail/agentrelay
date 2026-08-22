import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RelayQueue } from "../src/queue.js";
import { DEFAULT_STUCK_RESUMING_MS, selectFarFutureParkedJobs, selectStuckResumingJobs } from "../src/recover.js";
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

/** ISO string for `ms` after NOW. */
function aheadIso(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

const HORIZON = 8 * 24 * 60 * 60_000; // 8 days — the default reset horizon
const DAY = 24 * 60 * 60_000;

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

describe("selectFarFutureParkedJobs", () => {
  it("selects parked jobs whose reset lies beyond the horizon, ignoring near ones", () => {
    const jobs = [
      job({ id: "far", status: "waiting_for_reset", resetAt: aheadIso(100 * DAY) }),
      job({ id: "near", status: "waiting_for_reset", resetAt: aheadIso(2 * 60 * 60_000) }),
    ];
    const report = selectFarFutureParkedJobs(jobs, { nowMs: NOW, horizonMs: HORIZON });
    expect(report.total).toBe(2);
    expect(report.parked).toBe(2);
    expect(report.horizonMs).toBe(HORIZON);
    expect(report.farFuture.map((j) => j.id)).toEqual(["far"]);
  });

  it("only considers waiting_for_reset jobs (not queued/resuming/terminal)", () => {
    const jobs = [
      job({ id: "queued", status: "queued", resetAt: aheadIso(100 * DAY) }),
      job({ id: "resuming", status: "resuming", resetAt: aheadIso(100 * DAY) }),
      job({ id: "done", status: "completed", resetAt: aheadIso(100 * DAY) }),
      job({ id: "parked", status: "waiting_for_reset", resetAt: aheadIso(100 * DAY) }),
    ];
    const report = selectFarFutureParkedJobs(jobs, { nowMs: NOW, horizonMs: HORIZON });
    expect(report.parked).toBe(1);
    expect(report.farFuture.map((j) => j.id)).toEqual(["parked"]);
  });

  it("allows past/near resets — only the far-future side fails", () => {
    const jobs = [
      job({ id: "past", status: "waiting_for_reset", resetAt: agoIso(DAY) }),
      job({ id: "edge", status: "waiting_for_reset", resetAt: aheadIso(HORIZON - 60_000) }),
    ];
    const report = selectFarFutureParkedJobs(jobs, { nowMs: NOW, horizonMs: HORIZON });
    expect(report.farFuture).toEqual([]);
  });

  it("orders hits furthest-reset first (most extreme misparse leads)", () => {
    const jobs = [
      job({ id: "a", status: "waiting_for_reset", resetAt: aheadIso(30 * DAY) }),
      job({ id: "b", status: "waiting_for_reset", resetAt: aheadIso(365 * DAY) }),
      job({ id: "c", status: "waiting_for_reset", resetAt: aheadIso(60 * DAY) }),
    ];
    const report = selectFarFutureParkedJobs(jobs, { nowMs: NOW, horizonMs: HORIZON });
    expect(report.farFuture.map((j) => j.id)).toEqual(["b", "c", "a"]);
  });

  it("skips parked jobs with no resetAt or an unparseable one", () => {
    const jobs = [
      job({ id: "null", status: "waiting_for_reset", resetAt: null }),
      job({ id: "bad", status: "waiting_for_reset", resetAt: "not-a-date" }),
    ];
    const report = selectFarFutureParkedJobs(jobs, { nowMs: NOW, horizonMs: HORIZON });
    expect(report.parked).toBe(2);
    expect(report.farFuture).toEqual([]);
  });

  it("treats a disabled guard (null/0/non-finite horizon) as select-nothing", () => {
    const jobs = [job({ id: "far", status: "waiting_for_reset", resetAt: aheadIso(100 * DAY) })];
    for (const horizonMs of [null, 0, -1, Number.POSITIVE_INFINITY]) {
      const report = selectFarFutureParkedJobs(jobs, { nowMs: NOW, horizonMs });
      expect(report.horizonMs).toBeNull();
      expect(report.parked).toBe(1); // still counted as parked
      expect(report.farFuture).toEqual([]); // but nothing selected
    }
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
