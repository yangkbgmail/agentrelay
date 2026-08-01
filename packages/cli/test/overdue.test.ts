import { buildOverdueReport, type OverdueReport, type RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { formatElapsed, NO_OVERDUE_MESSAGE, renderOverdue, renderOverdueJson } from "../src/overdue.js";

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
    status: "waiting_for_reset",
    resetAt: at(-90 * 60_000),
    createdAt: at(-5 * 3_600_000),
    updatedAt: at(-5 * 3_600_000),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function report(jobs: RelayJob[], limit?: number): OverdueReport {
  return buildOverdueReport(jobs, NOW, limit);
}

describe("renderOverdue", () => {
  it("shows the caught-up message when nothing is overdue", () => {
    expect(renderOverdue(report([]))).toBe(NO_OVERDUE_MESSAGE);
  });

  it("appends the scope note to the empty message when scoped", () => {
    const out = renderOverdue(report([]), { scopeNote: "project=ghost" });
    expect(out).toContain(NO_OVERDUE_MESSAGE);
    expect(out).toContain("scope: project=ghost");
  });

  it("renders one row per overdue job worst-first with positions", () => {
    const out = renderOverdue(
      report([
        job({ id: "mild0000", project: "mild-app", resetAt: at(-30 * 60_000) }),
        job({ id: "worst000", project: "worst-app", resetAt: at(-5 * 3_600_000) }),
      ])
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("OVERDUE BY");
    expect(out.indexOf("worst-app")).toBeLessThan(out.indexOf("mild-app"));
    expect(out).toContain("1  ");
    expect(out).toContain("2  ");
  });

  it("renders the overdue duration in the compact elapsed format", () => {
    const out = renderOverdue(report([job({ resetAt: at(-90 * 60_000) })]));
    expect(out).toContain("1h 30m");
  });

  it("footer reports totals, worst lateness, and hidden rows under a limit", () => {
    const jobs = [
      job({ id: "j1", resetAt: at(-1 * 3_600_000) }),
      job({ id: "j2", resetAt: at(-2 * 3_600_000) }),
      job({ id: "j3", resetAt: at(-3 * 3_600_000) }),
    ];
    const out = renderOverdue(report(jobs, 1));
    expect(out).toContain("3 jobs overdue");
    expect(out).toContain("worst 3h 0m late");
    expect(out).toContain("2 more not shown");
  });

  it("uses the singular job word for a single overdue job", () => {
    const out = renderOverdue(report([job({ resetAt: at(-1 * 3_600_000) })]));
    expect(out).toContain("1 job overdue");
  });

  it("does not emit ANSI escapes when color is off", () => {
    const out = renderOverdue(report([job()]), { color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no escapes.
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("emits ANSI escapes when color is on", () => {
    const out = renderOverdue(report([job()]), { color: true });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting escapes present.
    expect(out).toMatch(/\x1b\[/);
  });
});

describe("formatElapsed", () => {
  it("formats sub-minute lateness as at least 1m", () => {
    expect(formatElapsed(5_000)).toBe("1m");
  });

  it("formats minutes only under an hour", () => {
    expect(formatElapsed(42 * 60_000)).toBe("42m");
  });

  it("formats hours and minutes under a day", () => {
    expect(formatElapsed(3 * 3_600_000 + 15 * 60_000)).toBe("3h 15m");
  });

  it("formats days and hours beyond a day", () => {
    expect(formatElapsed(2 * 86_400_000 + 4 * 3_600_000)).toBe("2d 4h");
  });
});

describe("renderOverdueJson", () => {
  it("emits the store path, report, and honest totals", () => {
    const r = report([job({ id: "j1", resetAt: at(-1 * 3_600_000) })], 1);
    const parsed = JSON.parse(
      renderOverdueJson({ storePath: "/tmp/jobs.json", generatedAt: "2026-07-30T10:00:00.000Z", report: r })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.report.entries).toHaveLength(1);
    expect(parsed.report.entries[0].job.id).toBe("j1");
    expect(parsed.report.totalOverdue).toBe(1);
  });

  it("includes the scope when one is passed", () => {
    const parsed = JSON.parse(
      renderOverdueJson({
        storePath: "/tmp/jobs.json",
        scope: { projects: ["demo"] },
        report: report([]),
      })
    );
    expect(parsed.scope).toEqual({ projects: ["demo"] });
  });
});
