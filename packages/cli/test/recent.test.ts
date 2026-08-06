import { buildRecentActivity, type RecentActivity, type RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_RECENT_MESSAGE, renderRecent, renderRecentJson } from "../src/recent.js";

const NOW = Date.parse("2026-07-30T10:00:00.000Z");

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
    status: "completed",
    resetAt: null,
    createdAt: at(-3600_000),
    updatedAt: at(-3600_000),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function activity(jobs: RelayJob[], limit?: number): RecentActivity {
  return buildRecentActivity(jobs, NOW, limit);
}

describe("renderRecent", () => {
  it("shows the empty message when there is no activity", () => {
    expect(renderRecent(activity([]))).toBe(NO_RECENT_MESSAGE);
  });

  it("appends the scope note to the empty message when scoped", () => {
    const out = renderRecent(activity([]), { scopeNote: "project=ghost" });
    expect(out).toContain(NO_RECENT_MESSAGE);
    expect(out).toContain("scope: project=ghost");
  });

  it("renders one row per job, newest first, with positions and statuses", () => {
    const out = renderRecent(
      activity([
        job({ id: "old00000", project: "old-app", status: "failed", updatedAt: at(-3 * 3600_000) }),
        job({ id: "new00000", project: "new-app", status: "completed", updatedAt: at(-60_000) }),
      ])
    );
    expect(out).toContain("PROJECT");
    expect(out).toContain("STATUS");
    expect(out.indexOf("new-app")).toBeLessThan(out.indexOf("old-app"));
    expect(out).toContain("completed");
    expect(out).toContain("failed");
    expect(out).toContain("1  ");
    expect(out).toContain("2  ");
  });

  it("renders a human 'ago' stamp for the last update", () => {
    const out = renderRecent(activity([job({ updatedAt: at(-2 * 3600_000) })]));
    expect(out).toContain("2h 0m ago");
  });

  it("renders 'just now' for a sub-second age and 'unknown' for a bad timestamp", () => {
    const recent = renderRecent(activity([job({ updatedAt: at(-100) })]));
    expect(recent).toContain("just now");
    const bad = renderRecent(activity([job({ updatedAt: "not-a-date" })]));
    expect(bad).toContain("unknown");
  });

  it("footer reports totals and hidden rows under a limit", () => {
    const jobs = [
      job({ id: "j1", updatedAt: at(-60_000) }),
      job({ id: "j2", updatedAt: at(-120_000) }),
      job({ id: "j3", updatedAt: at(-180_000) }),
    ];
    const out = renderRecent(activity(jobs, 1));
    expect(out).toContain("3 jobs");
    expect(out).toContain("2 more not shown");
  });

  it("does not emit ANSI escapes when color is off", () => {
    const out = renderRecent(activity([job()]), { color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no escapes.
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("colors the status cell when color is on", () => {
    const out = renderRecent(activity([job({ status: "failed" })]), { color: true });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting escapes are present.
    expect(out).toMatch(/\x1b\[/);
  });
});

describe("renderRecentJson", () => {
  it("emits the store path, feed, and honest totals", () => {
    const a = activity([job({ id: "j1", updatedAt: at(-60_000) })], 1);
    const parsed = JSON.parse(
      renderRecentJson({ storePath: "/tmp/jobs.json", generatedAt: "2026-07-30T10:00:00.000Z", activity: a })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.activity.entries).toHaveLength(1);
    expect(parsed.activity.entries[0].job.id).toBe("j1");
    expect(parsed.activity.total).toBe(1);
  });

  it("includes the scope when one is passed", () => {
    const parsed = JSON.parse(
      renderRecentJson({
        storePath: "/tmp/jobs.json",
        scope: { projects: ["demo"] },
        activity: activity([]),
      })
    );
    expect(parsed.scope).toEqual({ projects: ["demo"] });
  });
});
