import type { RelayJob } from "@agentrelay/core";
import { buildActivityFeed } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { EMPTY_MESSAGE, formatAge, NO_MATCH_MESSAGE, renderLogs, renderLogsJson } from "./logs.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}aaaaaaaa`,
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "waiting_for_reset",
    resetAt: "2026-08-10T13:00:00.000Z",
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T11:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-08-10T12:00:00.000Z");

describe("formatAge", () => {
  it("renders 'unknown' for a null timestamp", () => {
    expect(formatAge(null, NOW)).toBe("unknown");
  });

  it("renders 'just now' for a very recent or future timestamp", () => {
    expect(formatAge(NOW - 5_000, NOW)).toBe("just now");
    expect(formatAge(NOW + 60_000, NOW)).toBe("just now"); // clock skew clamps
  });

  it("renders minute/hour/day granularity", () => {
    expect(formatAge(NOW - 3 * 60_000, NOW)).toBe("3m ago");
    expect(formatAge(NOW - 5 * 3_600_000, NOW)).toBe("5h ago");
    expect(formatAge(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
  });

  it("falls back to an ISO date beyond ~30 days", () => {
    expect(formatAge(Date.parse("2026-01-01T00:00:00.000Z"), NOW)).toBe("2026-01-01");
  });
});

describe("renderLogs", () => {
  it("shows the empty-store hint when there are no jobs", () => {
    expect(renderLogs(buildActivityFeed([]), { now: NOW })).toContain(EMPTY_MESSAGE);
  });

  it("shows the no-match message when a scope filtered everything out", () => {
    const out = renderLogs(buildActivityFeed([]), { now: NOW, scopeNote: "status=failed" });
    expect(out).toContain(NO_MATCH_MESSAGE);
    expect(out).toContain("scope: status=failed");
  });

  it("lists rows newest-first with the distilled reason", () => {
    const feed = buildActivityFeed([
      job({ id: "old0000000", updatedAt: "2026-08-10T09:00:00.000Z", status: "completed", lastOutputTail: "done" }),
      job({ id: "new0000000", updatedAt: "2026-08-10T11:30:00.000Z", status: "failed", lastError: "Error: boom" }),
    ]);
    const out = renderLogs(feed, { now: NOW });
    const lines = out.split("\n");
    // Header, blank, then rows: newest (failed) before older (completed).
    const rowLines = lines.filter((l) => l.includes("new00000") || l.includes("old00000"));
    expect(rowLines[0]).toContain("new00000");
    expect(rowLines[0]).toContain("Error: boom");
    expect(rowLines[1]).toContain("old00000");
    expect(rowLines[1]).toContain("done");
    expect(out).toContain("2 of 2 jobs shown");
  });

  it("reports hidden rows under a limit", () => {
    const jobs = [
      job({ id: "a000000000", updatedAt: "2026-08-10T09:00:00.000Z" }),
      job({ id: "b000000000", updatedAt: "2026-08-10T11:00:00.000Z" }),
      job({ id: "c000000000", updatedAt: "2026-08-10T10:00:00.000Z" }),
    ];
    const out = renderLogs(buildActivityFeed(jobs, { limit: 1 }), { now: NOW });
    expect(out).toContain("1 of 3 jobs shown");
    expect(out).toContain("2 more not shown");
    expect(out).toContain("b000000"); // the newest row is the one kept
  });

  it("emits no ANSI codes when color is off", () => {
    const out = renderLogs(buildActivityFeed([job({ status: "failed", lastError: "x" })]), { now: NOW, color: false });
    expect(out).not.toContain("\x1b[");
  });
});

describe("renderLogsJson", () => {
  it("emits a compact per-entry view with reason and totals", () => {
    const feed = buildActivityFeed([
      job({ id: "j111111111", status: "failed", lastError: "Error: boom", updatedAt: "2026-08-10T11:00:00.000Z" }),
    ]);
    const parsed = JSON.parse(
      renderLogsJson({ storePath: "/tmp/jobs.json", generatedAt: "2026-08-10T12:00:00.000Z", feed })
    );
    expect(parsed).toMatchObject({ storePath: "/tmp/jobs.json", total: 1, shown: 1, hidden: 0 });
    expect(parsed.entries[0]).toMatchObject({
      id: "j111111111",
      status: "failed",
      reason: { kind: "error", text: "Error: boom" },
    });
    expect(typeof parsed.entries[0].updatedMs).toBe("number");
  });

  it("echoes an active scope", () => {
    const parsed = JSON.parse(
      renderLogsJson({ storePath: "/s", feed: buildActivityFeed([]), scope: { statuses: ["failed"] } })
    );
    expect(parsed.scope).toEqual({ statuses: ["failed"] });
  });
});
