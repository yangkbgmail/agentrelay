import { describe, expect, it } from "vitest";
import { computeResumeAgenda, DEFAULT_AGENDA_WINDOW_MS } from "./agenda.js";
import type { AgentTool, JobStatus, RelayJob } from "./types.js";

const NOW = Date.parse("2026-07-24T10:00:00.000Z");

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "proj",
    tool: "claude-code" as AgentTool,
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "waiting_for_reset" as JobStatus,
    resetAt: null,
    createdAt: "2026-07-24T09:00:00.000Z",
    updatedAt: "2026-07-24T09:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

/** Build a waiting job whose reset is `mins` minutes after NOW. */
function waiting(mins: number, overrides: Partial<RelayJob> = {}): RelayJob {
  return job({ resetAt: new Date(NOW + mins * 60_000).toISOString(), ...overrides });
}

describe("computeResumeAgenda", () => {
  it("returns an empty agenda for a store with nothing waiting", () => {
    const agenda = computeResumeAgenda([job({ status: "completed", resetAt: null })], { now: NOW });
    expect(agenda.totalWaiting).toBe(0);
    expect(agenda.dueNow).toBe(0);
    expect(agenda.windows).toEqual([]);
    expect(agenda.windowMs).toBe(DEFAULT_AGENDA_WINDOW_MS);
  });

  it("ignores non-waiting jobs and jobs with an unparseable reset", () => {
    const agenda = computeResumeAgenda(
      [
        waiting(5),
        job({ status: "queued", resetAt: new Date(NOW + 60_000).toISOString() }),
        job({ status: "resuming", resetAt: new Date(NOW + 60_000).toISOString() }),
        job({ status: "waiting_for_reset", resetAt: "not-a-date" }),
        job({ status: "waiting_for_reset", resetAt: null }),
      ],
      { now: NOW }
    );
    expect(agenda.totalWaiting).toBe(1);
    expect(agenda.windows).toHaveLength(1);
  });

  it("groups jobs resuming within the same window into one herd, earliest window first", () => {
    // 3 jobs in the same minute (herd), one a minute later.
    const agenda = computeResumeAgenda([waiting(5), waiting(5.5), waiting(5.9), waiting(6.2)], { now: NOW });
    expect(agenda.totalWaiting).toBe(4);
    expect(agenda.windows).toHaveLength(2);

    const [first, second] = agenda.windows;
    expect(first.count).toBe(3);
    expect(first.due).toBe(false);
    expect(second.count).toBe(1);
    // Chronological order between windows.
    expect((first.windowStart as number) < (second.windowStart as number)).toBe(true);
  });

  it("collapses all already-due jobs into a single due-now bucket at the front", () => {
    const agenda = computeResumeAgenda([waiting(-10), waiting(-1), waiting(5)], { now: NOW });
    expect(agenda.dueNow).toBe(2);
    const due = agenda.windows[0];
    expect(due.due).toBe(true);
    expect(due.windowStart).toBeNull();
    expect(due.windowStartIso).toBeNull();
    expect(due.opensInMs).toBe(0);
    expect(due.count).toBe(2);
    // The future job is its own window after the due bucket.
    expect(agenda.windows[1].due).toBe(false);
  });

  it("orders entries within a window by reset, then createdAt, then id", () => {
    // Same reset instant → tiebreak on createdAt (older first), then id.
    const at = new Date(NOW + 5 * 60_000).toISOString();
    const late = job({ id: "b", resetAt: at, createdAt: "2026-07-24T09:30:00.000Z" });
    const early = job({ id: "a", resetAt: at, createdAt: "2026-07-24T09:00:00.000Z" });
    const agenda = computeResumeAgenda([late, early], { now: NOW });
    const ids = agenda.windows[0].entries.map((e) => e.job.id);
    expect(ids).toEqual(["a", "b"]);
  });

  it("computes dueInMs and opensInMs relative to now", () => {
    const agenda = computeResumeAgenda([waiting(5)], { now: NOW });
    const win = agenda.windows[0];
    expect(win.entries[0].dueInMs).toBe(5 * 60_000);
    expect(win.opensInMs).toBe(5 * 60_000);
  });

  it("honours a custom window width", () => {
    // With a 1h window, jobs 5m and 50m out land in the same bucket.
    const agenda = computeResumeAgenda([waiting(5), waiting(50)], { now: NOW, windowMs: 60 * 60_000 });
    expect(agenda.windows).toHaveLength(1);
    expect(agenda.windows[0].count).toBe(2);
  });

  it("falls back to the default window for a non-positive or non-finite width", () => {
    expect(computeResumeAgenda([waiting(5)], { now: NOW, windowMs: 0 }).windowMs).toBe(DEFAULT_AGENDA_WINDOW_MS);
    expect(computeResumeAgenda([waiting(5)], { now: NOW, windowMs: -5 }).windowMs).toBe(DEFAULT_AGENDA_WINDOW_MS);
    expect(computeResumeAgenda([waiting(5)], { now: NOW, windowMs: Number.NaN }).windowMs).toBe(
      DEFAULT_AGENDA_WINDOW_MS
    );
  });

  it("keeps the earliest N windows and reports the hidden tail", () => {
    const agenda = computeResumeAgenda([waiting(1), waiting(10), waiting(20), waiting(30)], {
      now: NOW,
      limit: 2,
    });
    expect(agenda.windows).toHaveLength(2);
    expect(agenda.hiddenWindows).toBe(2);
    expect(agenda.hiddenJobs).toBe(2);
    // Totals still reflect everything, not just the shown windows.
    expect(agenda.totalWaiting).toBe(4);
  });

  it("does not mutate the input job array order", () => {
    const jobs = [waiting(9), waiting(1)];
    const snapshot = jobs.map((j) => j.id);
    computeResumeAgenda(jobs, { now: NOW });
    expect(jobs.map((j) => j.id)).toEqual(snapshot);
  });
});
