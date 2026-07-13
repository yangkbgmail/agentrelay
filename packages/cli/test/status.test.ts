import type { JobStatus, RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  EMPTY_MESSAGE,
  formatCountdown,
  renderStatusJson,
  renderStatusTable,
  renderWatchFrame,
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
