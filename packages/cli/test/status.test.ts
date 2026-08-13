import type { JobStatus, RelayJob } from "@agentrelay/core";
import { scopeJobs } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  EMPTY_MESSAGE,
  formatCountdown,
  groupJobs,
  isSelectionFiltering,
  renderGroupedStatusJson,
  renderGroupedStatusTable,
  renderStatusJson,
  renderStatusTable,
  renderWatchFrame,
  selectJobs,
  summaryLine,
} from "../src/status.js";

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

describe("formatCountdown", () => {
  it("returns '-' for null or unparseable reset times", () => {
    expect(formatCountdown(null, NOW)).toBe("-");
    expect(formatCountdown("not-a-date", NOW)).toBe("-");
  });

  it("returns 'due now' once the reset time has passed", () => {
    expect(formatCountdown(at(-1), NOW)).toBe("due now");
    expect(formatCountdown(at(0), NOW)).toBe("due now");
  });

  it("shows minutes only under an hour", () => {
    expect(formatCountdown(at(30 * 60_000), NOW)).toBe("30m");
  });

  it("shows hours and minutes under a day", () => {
    expect(formatCountdown(at(2 * 3600_000 + 5 * 60_000), NOW)).toBe("2h 5m");
  });

  it("shows days and hours past 24h (e.g. long backoff)", () => {
    expect(formatCountdown(at(2 * 24 * 3600_000 + 3 * 3600_000), NOW)).toBe("2d 3h");
  });
});

describe("renderStatusTable", () => {
  it("returns the onboarding message when there are no jobs", () => {
    expect(renderStatusTable([], { now: NOW })).toBe(EMPTY_MESSAGE);
  });

  it("renders a header, a row per job, and a summary footer", () => {
    const out = renderStatusTable(
      [
        job({ id: "11111111aaaa", project: "web", status: "waiting_for_reset", resetAt: at(60 * 60_000) }),
        job({ id: "22222222bbbb", project: "api", status: "completed", resetAt: null, attempts: 3 }),
      ],
      { now: NOW }
    );

    // Header columns.
    for (const col of ["ID", "PROJECT", "STATUS", "RESETS IN", "ATTEMPTS"]) {
      expect(out).toContain(col);
    }
    // Row content (ids truncated to 8 chars).
    expect(out).toContain("11111111");
    expect(out).toContain("web");
    expect(out).toContain("waiting_for_reset");
    expect(out).toContain("1h 0m");
    expect(out).toContain("api");
    expect(out).toContain("completed");
    // Footer summary counts + next reset.
    expect(out).toContain("2 job(s)");
    expect(out).toContain("waiting_for_reset:1");
    expect(out).toContain("completed:1");
    expect(out).toContain("next reset in 1h 0m");
  });

  it("emits no ANSI escape codes by default but does when color is on", () => {
    const plain = renderStatusTable([job()], { now: NOW });
    expect(plain).not.toContain("\x1b[");

    const colored = renderStatusTable([job({ status: "failed" })], { now: NOW, color: true });
    expect(colored).toContain("\x1b[31m"); // red for failed
    expect(colored).toContain("\x1b[0m");
  });
});

describe("summaryLine", () => {
  it("lists only non-zero statuses and 'none' when empty", () => {
    const empty = summaryLine({ total: 0, byStatus: emptyCounts(), nextResetAt: null }, NOW);
    expect(empty).toBe("0 job(s) — none");
  });

  it("includes the next reset countdown when a job is waiting", () => {
    const line = summaryLine(
      { total: 1, byStatus: { ...emptyCounts(), waiting_for_reset: 1 }, nextResetAt: at(45 * 60_000) },
      NOW
    );
    expect(line).toContain("1 job(s)");
    expect(line).toContain("waiting_for_reset:1");
    expect(line).toContain("next reset in 45m");
  });
});

describe("renderStatusJson", () => {
  it("produces valid JSON with storePath, summary and jobs", () => {
    const raw = renderStatusJson([job({ status: "completed" })], "/tmp/store.json", "2026-07-13T00:00:00.000Z");
    const parsed = JSON.parse(raw);
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-13T00:00:00.000Z");
    expect(parsed.summary.total).toBe(1);
    expect(parsed.summary.byStatus.completed).toBe(1);
    expect(parsed.jobs).toHaveLength(1);
    expect(parsed.jobs[0].project).toBe("demo");
  });

  it("caps `jobs` by limit while summary/total span the full set", () => {
    const jobs = [
      job({ id: "aaaa1111", project: "one" }),
      job({ id: "bbbb2222", project: "two" }),
      job({ id: "cccc3333", project: "three" }),
    ];
    const parsed = JSON.parse(renderStatusJson(jobs, "/tmp/store.json", "2026-07-13T00:00:00.000Z", 2));
    expect(parsed.total).toBe(3);
    expect(parsed.returned).toBe(2);
    expect(parsed.summary.total).toBe(3);
    expect(parsed.jobs).toHaveLength(2);
    expect(parsed.jobs.map((j: RelayJob) => j.id)).toEqual(["aaaa1111", "bbbb2222"]);
  });

  it("returns every job when no limit is given (total === returned)", () => {
    const parsed = JSON.parse(renderStatusJson([job(), job()], "/tmp/store.json", "2026-07-13T00:00:00.000Z"));
    expect(parsed.total).toBe(2);
    expect(parsed.returned).toBe(2);
    expect(parsed.jobs).toHaveLength(2);
  });
});

describe("renderWatchFrame", () => {
  it("includes the live title, store path, timestamp and the table", () => {
    const frame = renderWatchFrame([job()], "/tmp/store.json", 2000, NOW);
    expect(frame).toContain("agentrelay status");
    expect(frame).toContain("every 2s");
    expect(frame).toContain("/tmp/store.json");
    expect(frame).toContain("2026-07-13 00:00:00");
    expect(frame).toContain("waiting_for_reset");
  });

  it("passes --limit through to the underlying table", () => {
    const jobs = [
      job({ id: "aaaa1111", project: "one" }),
      job({ id: "bbbb2222", project: "two" }),
      job({ id: "cccc3333", project: "three" }),
    ];
    const frame = renderWatchFrame(jobs, "/tmp/store.json", 2000, NOW, 1);
    expect(frame).toContain("aaaa1111");
    expect(frame).not.toContain("bbbb2222");
    expect(frame).toContain("2 more not shown");
  });
});

describe("renderStatusTable --limit", () => {
  const jobs = [
    job({ id: "aaaa1111", project: "one" }),
    job({ id: "bbbb2222", project: "two" }),
    job({ id: "cccc3333", project: "three" }),
  ];

  it("caps the shown rows and adds a truncation note", () => {
    const out = renderStatusTable(jobs, { now: NOW, limit: 2 });
    expect(out).toContain("aaaa1111");
    expect(out).toContain("bbbb2222");
    expect(out).not.toContain("cccc3333");
    expect(out).toContain("… 1 more not shown (showing 2 of 3). Raise --limit to see more.");
  });

  it("keeps the summary counting every job, not just the shown rows", () => {
    const out = renderStatusTable(jobs, { now: NOW, limit: 1 });
    // Footer still reports the full set of 3 jobs.
    expect(out).toContain("3 job(s)");
    expect(out).toContain("waiting_for_reset:3");
  });

  it("adds no note when the limit is not smaller than the job count", () => {
    expect(renderStatusTable(jobs, { now: NOW, limit: 3 })).not.toContain("more not shown");
    expect(renderStatusTable(jobs, { now: NOW, limit: 99 })).not.toContain("more not shown");
  });

  it("treats a missing or non-positive limit as no cap", () => {
    expect(renderStatusTable(jobs, { now: NOW })).not.toContain("more not shown");
    expect(renderStatusTable(jobs, { now: NOW, limit: 0 })).not.toContain("more not shown");
    // All three rows survive without a cap.
    for (const id of ["aaaa1111", "bbbb2222", "cccc3333"]) {
      expect(renderStatusTable(jobs, { now: NOW })).toContain(id);
    }
  });
});

describe("selectJobs", () => {
  const jobs: RelayJob[] = [
    job({
      id: "aaaa1111",
      project: "web",
      tool: "claude-code",
      status: "completed",
      resetAt: null,
      attempts: 3,
      createdAt: at(-3000),
    }),
    job({
      id: "bbbb2222",
      project: "api",
      tool: "codex-cli",
      status: "waiting_for_reset",
      resetAt: at(90 * 60_000),
      attempts: 1,
      createdAt: at(-2000),
    }),
    job({
      id: "cccc3333",
      project: "cli",
      tool: "claude-code",
      status: "failed",
      resetAt: at(30 * 60_000),
      attempts: 5,
      createdAt: at(-1000),
    }),
  ];

  it("returns a fresh array and never mutates the input", () => {
    const out = selectJobs(jobs);
    expect(out).not.toBe(jobs);
    expect(out.map((j) => j.id)).toEqual(jobs.map((j) => j.id));
  });

  it("filters to only the requested statuses", () => {
    const out = selectJobs(jobs, { statuses: ["failed", "completed"] });
    expect(out.map((j) => j.status).sort()).toEqual(["completed", "failed"]);
  });

  it("returns an empty array when the status filter matches nothing", () => {
    expect(selectJobs(jobs, { statuses: ["queued"] })).toEqual([]);
  });

  it("sorts by project name ascending", () => {
    const out = selectJobs(jobs, { sort: "project" });
    expect(out.map((j) => j.project)).toEqual(["api", "cli", "web"]);
  });

  it("sorts by attempts numerically", () => {
    const out = selectJobs(jobs, { sort: "attempts" });
    expect(out.map((j) => j.attempts)).toEqual([1, 3, 5]);
  });

  it("sorts by reset time with null reset times last", () => {
    const out = selectJobs(jobs, { sort: "reset" });
    // cli (30m) then api (90m) then web (null → last).
    expect(out.map((j) => j.project)).toEqual(["cli", "api", "web"]);
  });

  it("sorts by status in lifecycle order", () => {
    const out = selectJobs(jobs, { sort: "status" });
    // waiting_for_reset (idx 1) < completed (idx 3) < failed (idx 4).
    expect(out.map((j) => j.status)).toEqual(["waiting_for_reset", "completed", "failed"]);
  });

  it("reverse flips the sort direction", () => {
    const out = selectJobs(jobs, { sort: "attempts", reverse: true });
    expect(out.map((j) => j.attempts)).toEqual([5, 3, 1]);
  });

  it("reverse alone flips the store order without sorting", () => {
    const out = selectJobs(jobs, { reverse: true });
    expect(out.map((j) => j.id)).toEqual(["cccc3333", "bbbb2222", "aaaa1111"]);
  });

  it("combines filter and sort", () => {
    const out = selectJobs(jobs, { statuses: ["failed", "waiting_for_reset"], sort: "attempts" });
    expect(out.map((j) => j.attempts)).toEqual([1, 5]);
  });

  it("filters by tool (OR within the dimension)", () => {
    const out = selectJobs(jobs, { tools: ["claude-code"] });
    expect(out.map((j) => j.id)).toEqual(["aaaa1111", "cccc3333"]);
  });

  it("filters by an unknown tool string to nothing (raw match, no coercion)", () => {
    expect(selectJobs(jobs, { tools: ["gemini-cli"] })).toEqual([]);
  });

  it("filters by project (exact match)", () => {
    const out = selectJobs(jobs, { projects: ["api", "cli"] });
    expect(out.map((j) => j.project).sort()).toEqual(["api", "cli"]);
  });

  it("ANDs the tool, project and status dimensions together", () => {
    // claude-code has web+cli; status failed leaves cli; project cli keeps it.
    const out = selectJobs(jobs, { tools: ["claude-code"], statuses: ["failed"], projects: ["cli"] });
    expect(out.map((j) => j.id)).toEqual(["cccc3333"]);
    // A project that the other filters exclude yields nothing.
    expect(selectJobs(jobs, { tools: ["claude-code"], projects: ["api"] })).toEqual([]);
  });

  it("combines a tool filter with a sort", () => {
    const out = selectJobs(jobs, { tools: ["claude-code"], sort: "attempts" });
    expect(out.map((j) => j.attempts)).toEqual([3, 5]);
  });
});

describe("isSelectionFiltering", () => {
  it("is false for an empty or sort-only selection", () => {
    expect(isSelectionFiltering({})).toBe(false);
    expect(isSelectionFiltering({ sort: "attempts", reverse: true })).toBe(false);
    expect(isSelectionFiltering({ statuses: [], tools: [], projects: [] })).toBe(false);
  });

  it("is true when any filter dimension is set", () => {
    expect(isSelectionFiltering({ statuses: ["failed"] })).toBe(true);
    expect(isSelectionFiltering({ tools: ["codex-cli"] })).toBe(true);
    expect(isSelectionFiltering({ projects: ["web"] })).toBe(true);
  });
});

// The `status` command applies the same time window as `stats`/`export`:
// the --since/--until window via core scopeJobs, then the
// --status/--tool/--project/--sort/--reverse selection via selectJobs. These
// tests exercise that exact pipeline, matching the CLI wiring in cli.ts.
describe("status --since/--until pipeline (scopeJobs then selectJobs)", () => {
  const now = Date.parse("2026-07-19T00:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;

  function windowJob(overrides: Partial<RelayJob>): RelayJob {
    return job({ status: "completed", resetAt: null, ...overrides });
  }

  const jobs: RelayJob[] = [
    windowJob({ id: "old", project: "alpha", tool: "codex-cli", createdAt: ago(30 * DAY), updatedAt: ago(30 * DAY) }),
    windowJob({ id: "recent-codex", project: "beta", tool: "codex-cli", createdAt: ago(HOUR), updatedAt: ago(HOUR) }),
    windowJob({
      id: "recent-claude",
      project: "gamma",
      tool: "claude-code",
      createdAt: ago(HOUR),
      updatedAt: ago(HOUR),
    }),
  ];

  it("keeps only jobs created within a --since window", () => {
    const windowed = scopeJobs(jobs, { createdFrom: now - DAY });
    expect(windowed.map((j) => j.id).sort()).toEqual(["recent-claude", "recent-codex"]);
  });

  it("combines a --since window with a --tool filter (window then select)", () => {
    const windowed = scopeJobs(jobs, { createdFrom: now - DAY });
    const selected = selectJobs(windowed, { tools: ["codex-cli"] });
    expect(selected.map((j) => j.id)).toEqual(["recent-codex"]);
  });

  it("scopes to a --since/--until band (created between 7 and 1 days ago)", () => {
    const mid = windowJob({ id: "mid", project: "delta", createdAt: ago(3 * DAY), updatedAt: ago(3 * DAY) });
    const windowed = scopeJobs([...jobs, mid], { createdFrom: now - 7 * DAY, createdTo: now - DAY });
    expect(windowed.map((j) => j.id)).toEqual(["mid"]);
  });
});

function emptyCounts(): Record<JobStatus, number> {
  return {
    queued: 0,
    waiting_for_reset: 0,
    resuming: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
}

describe("groupJobs", () => {
  it("partitions jobs by project, ranked by size (desc) then key (asc)", () => {
    const jobs = [
      job({ id: "w1", project: "web" }),
      job({ id: "a1", project: "api" }),
      job({ id: "w2", project: "web" }),
      job({ id: "c1", project: "cli" }),
      job({ id: "a2", project: "api" }),
      job({ id: "w3", project: "web" }),
    ];
    const groups = groupJobs(jobs, "project");
    expect(groups.map((g) => `${g.key}:${g.jobs.length}`)).toEqual(["web:3", "api:2", "cli:1"]);
  });

  it("breaks size ties by key ascending", () => {
    const jobs = [job({ project: "zeta" }), job({ project: "alpha" }), job({ project: "mu" })];
    expect(groupJobs(jobs, "project").map((g) => g.key)).toEqual(["alpha", "mu", "zeta"]);
  });

  it("keeps each group's jobs in input order (so upstream --sort carries through)", () => {
    const jobs = [
      job({ id: "first", project: "web" }),
      job({ id: "second", project: "web" }),
      job({ id: "third", project: "web" }),
    ];
    expect(groupJobs(jobs, "project")[0].jobs.map((j) => j.id)).toEqual(["first", "second", "third"]);
  });

  it("groups by tool and by status too", () => {
    const jobs = [
      job({ tool: "claude-code", status: "failed" }),
      job({ tool: "codex-cli", status: "completed" }),
      job({ tool: "claude-code", status: "failed" }),
    ];
    expect(groupJobs(jobs, "tool").map((g) => `${g.key}:${g.jobs.length}`)).toEqual(["claude-code:2", "codex-cli:1"]);
    expect(groupJobs(jobs, "status").map((g) => `${g.key}:${g.jobs.length}`)).toEqual(["failed:2", "completed:1"]);
  });

  it("does not mutate the input array", () => {
    const jobs = [job({ project: "b" }), job({ project: "a" })];
    const snapshot = jobs.map((j) => j.project);
    groupJobs(jobs, "project");
    expect(jobs.map((j) => j.project)).toEqual(snapshot);
  });
});

describe("renderGroupedStatusTable", () => {
  it("shows the empty message when there are no jobs", () => {
    expect(renderGroupedStatusTable([], "project", { now: NOW })).toBe(EMPTY_MESSAGE);
  });

  it("renders one labeled section per group with counts", () => {
    const jobs = [
      job({ id: "w1", project: "web" }),
      job({ id: "a1", project: "api" }),
      job({ id: "w2", project: "web" }),
    ];
    const out = renderGroupedStatusTable(jobs, "project", { now: NOW });
    expect(out).toContain("▸ project=web (2)");
    expect(out).toContain("▸ project=api (1)");
    // web section (larger) comes before api section.
    expect(out.indexOf("project=web")).toBeLessThan(out.indexOf("project=api"));
    // Footer still counts every job.
    expect(out).toContain("3 job(s)");
  });

  it("caps rows per group with a per-group truncation note", () => {
    const jobs = [
      job({ id: "w1", project: "web" }),
      job({ id: "w2", project: "web" }),
      job({ id: "w3", project: "web" }),
      job({ id: "a1", project: "api" }),
    ];
    const out = renderGroupedStatusTable(jobs, "project", { now: NOW, limit: 1 });
    expect(out).toContain("▸ project=web (3)");
    expect(out).toContain("… 2 more not shown (showing 1 of 3)");
    // The single-job api group is not truncated.
    expect(out).toContain("▸ project=api (1)");
  });
});

describe("renderGroupedStatusJson", () => {
  it("emits provenance, groupBy, summary, and per-group job lists", () => {
    const jobs = [
      job({ id: "w1", project: "web" }),
      job({ id: "a1", project: "api" }),
      job({ id: "w2", project: "web" }),
    ];
    const parsed = JSON.parse(renderGroupedStatusJson(jobs, "project", "/tmp/store.json", "2026-07-13T00:00:00.000Z"));
    expect(parsed.groupBy).toBe("project");
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.total).toBe(3);
    expect(parsed.groups.map((g: { key: string; count: number }) => `${g.key}:${g.count}`)).toEqual(["web:2", "api:1"]);
    expect(parsed.groups[0].jobs.map((j: RelayJob) => j.id)).toEqual(["w1", "w2"]);
  });

  it("caps per-group jobs by limit and reports returned vs count", () => {
    const jobs = [
      job({ id: "w1", project: "web" }),
      job({ id: "w2", project: "web" }),
      job({ id: "w3", project: "web" }),
    ];
    const parsed = JSON.parse(
      renderGroupedStatusJson(jobs, "project", "/tmp/store.json", "2026-07-13T00:00:00.000Z", 2)
    );
    expect(parsed.groups[0].count).toBe(3);
    expect(parsed.groups[0].returned).toBe(2);
    expect(parsed.groups[0].jobs).toHaveLength(2);
  });
});

describe("renderWatchFrame with groupBy", () => {
  it("renders the grouped table when a dimension is given", () => {
    const jobs = [job({ id: "w1", project: "web" }), job({ id: "a1", project: "api" })];
    const frame = renderWatchFrame(jobs, "/tmp/store.json", 2000, NOW, undefined, "project");
    expect(frame).toContain("project=web");
    expect(frame).toContain("project=api");
  });
});
