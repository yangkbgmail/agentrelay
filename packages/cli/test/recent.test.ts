import { buildRecentActivity, type RecentActivity, type RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_RECENT_MESSAGE, renderRecent, renderRecentJson, renderRecentWatchFrame } from "../src/recent.js";

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
    createdAt: at(-2 * 3_600_000),
    updatedAt: at(-60 * 60_000),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function feed(jobs: RelayJob[], limit?: number): RecentActivity {
  return buildRecentActivity(jobs, NOW, limit === undefined ? {} : { limit });
}

describe("renderRecent", () => {
  it("shows the empty message when nothing is resolved", () => {
    expect(renderRecent(feed([]), { color: false })).toBe(NO_RECENT_MESSAGE);
  });

  it("appends the scope note to the empty message when scoped", () => {
    const out = renderRecent(feed([]), { scopeNote: "project=ghost" });
    expect(out).toContain(NO_RECENT_MESSAGE);
    expect(out).toContain("scope: project=ghost");
  });

  it("renders one row per resolved job, most recent first, with positions", () => {
    const out = renderRecent(
      feed([
        job({ id: "older000", project: "older-app", updatedAt: at(-5 * 3_600_000) }),
        job({ id: "newer000", project: "newer-app", updatedAt: at(-30 * 60_000) }),
      ]),
      { color: false }
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("OUTCOME");
    expect(out.indexOf("newer-app")).toBeLessThan(out.indexOf("older-app"));
    expect(out).toContain("1  ");
    expect(out).toContain("2  ");
  });

  it("shows the outcome and how long ago it resolved", () => {
    const out = renderRecent(feed([job({ status: "failed", updatedAt: at(-90 * 60_000) })]), { color: false });
    expect(out).toContain("failed");
    expect(out).toContain("1h 30m ago");
  });

  it("shows the resolution span, or '-' when it can't be computed", () => {
    const out = renderRecent(
      feed([
        job({ id: "spanjob0", createdAt: at(-3 * 3_600_000), updatedAt: at(-1 * 3_600_000) }),
        job({ id: "nospan00", createdAt: "nope", updatedAt: at(-30 * 60_000) }),
      ]),
      { color: false }
    );
    // spanjob resolved 1h ago, created 3h ago -> took 2h 0m; nospan -> "-"
    expect(out).toContain("2h 0m");
    expect(out).toContain("-");
  });

  it("footer reports totals, the per-outcome split, and hidden rows under a limit", () => {
    const jobs = [
      job({ id: "j1", status: "completed", updatedAt: at(-10 * 60_000) }),
      job({ id: "j2", status: "failed", updatedAt: at(-20 * 60_000) }),
      job({ id: "j3", status: "cancelled", updatedAt: at(-30 * 60_000) }),
    ];
    const out = renderRecent(feed(jobs, 1), { color: false });
    expect(out).toContain("3 jobs resolved");
    expect(out).toContain("completed:1");
    expect(out).toContain("failed:1");
    expect(out).toContain("cancelled:1");
    expect(out).toContain("2 more not shown");
  });

  it("does not emit ANSI escapes when color is off", () => {
    const out = renderRecent(feed([job()]), { color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no escapes.
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("colors the outcome cell when color is on", () => {
    const out = renderRecent(feed([job({ status: "completed" })]), { color: true });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting green escape present.
    expect(out).toMatch(/\x1b\[32m/);
  });
});

describe("renderRecentWatchFrame", () => {
  it("prepends a live title with the store path, timestamp, and interval", () => {
    const out = renderRecentWatchFrame(feed([job({ updatedAt: at(-30 * 60_000) })]), "/tmp/jobs.json", 5000, NOW);
    const lines = out.split("\n");
    expect(lines[0]).toContain("agentrelay recent");
    expect(lines[0]).toContain("every 5s");
    expect(lines[0]).toContain("Ctrl-C to exit");
    expect(lines[1]).toContain("2026-07-30 10:00:00Z");
    expect(lines[1]).toContain("/tmp/jobs.json");
    expect(lines[2]).toBe("");
    expect(out).toContain("OUTCOME");
  });

  it("carries the scope note into the frame body", () => {
    const out = renderRecentWatchFrame(feed([]), "/tmp/jobs.json", 2000, NOW, "project=ghost");
    expect(out).toContain(NO_RECENT_MESSAGE);
    expect(out).toContain("scope: project=ghost");
  });
});

describe("renderRecentJson", () => {
  it("emits the store path, feed, and honest totals", () => {
    const f = feed([job({ id: "j1", status: "failed", updatedAt: at(-10 * 60_000) })], 1);
    const parsed = JSON.parse(
      renderRecentJson({ storePath: "/tmp/jobs.json", generatedAt: "2026-07-30T10:00:00.000Z", feed: f })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.feed.entries).toHaveLength(1);
    expect(parsed.feed.entries[0].job.id).toBe("j1");
    expect(parsed.feed.entries[0].outcome).toBe("failed");
    expect(parsed.feed.totalResolved).toBe(1);
  });

  it("includes the scope when one is passed", () => {
    const parsed = JSON.parse(
      renderRecentJson({
        storePath: "/tmp/jobs.json",
        scope: { projects: ["demo"] },
        feed: feed([]),
      })
    );
    expect(parsed.scope).toEqual({ projects: ["demo"] });
  });
});
