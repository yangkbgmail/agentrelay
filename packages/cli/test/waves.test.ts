import { buildResumeWaves, type RelayJob, type ResumeWaves } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_WAVES_MESSAGE, renderWaves, renderWavesJson } from "../src/waves.js";

const NOW = Date.parse("2026-07-30T10:00:00.000Z");
const HOUR = 60 * 60_000;

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

function waves(jobs: RelayJob[], opts?: { windowMs?: number; maxWindows?: number }): ResumeWaves {
  return buildResumeWaves(jobs, NOW, opts);
}

describe("renderWaves", () => {
  it("shows the empty message when nothing is waiting", () => {
    expect(renderWaves(waves([]))).toBe(NO_WAVES_MESSAGE);
  });

  it("appends the scope note to the empty message when scoped", () => {
    const out = renderWaves(waves([]), { scopeNote: "project=ghost" });
    expect(out).toContain(NO_WAVES_MESSAGE);
    expect(out).toContain("scope: project=ghost");
  });

  it("renders one row per window with a header and a bar for non-empty windows", () => {
    const out = renderWaves(waves([job({ resetAt: at(0.5 * HOUR) }), job({ resetAt: at(2.5 * HOUR) })]));
    expect(out).toContain("resume load");
    expect(out).toContain("now→1h 0m");
    expect(out).toContain("█");
  });

  it("labels the first window 'now' and later windows by offset", () => {
    const out = renderWaves(waves([job({ resetAt: at(0.5 * HOUR) }), job({ resetAt: at(1.5 * HOUR) })]));
    expect(out).toContain("now→1h 0m");
    expect(out).toContain("1h 0m→2h 0m");
  });

  it("shows a baseline dot for an empty window between resumes", () => {
    const out = renderWaves(waves([job({ resetAt: at(0.1 * HOUR) }), job({ resetAt: at(2.1 * HOUR) })]));
    expect(out).toContain("·");
  });

  it("footer reports totals, due-now, and the peak window", () => {
    const out = renderWaves(
      waves([
        job({ id: "j1", resetAt: at(-60_000) }), // due now, window 0
        job({ id: "j2", resetAt: at(0.5 * HOUR) }), // window 0
        job({ id: "j3", resetAt: at(2.5 * HOUR) }), // window 2
      ])
    );
    expect(out).toContain("3 jobs waiting");
    expect(out).toContain("1 due now");
    expect(out).toContain("peak 2 in now→1h 0m");
  });

  it("reports jobs beyond the horizon in the footer", () => {
    const out = renderWaves(
      waves([job({ resetAt: at(0.5 * HOUR) }), job({ resetAt: at(5 * HOUR) })], { maxWindows: 2 })
    );
    expect(out).toContain("1 beyond horizon");
  });

  it("mentions beyond-horizon jobs even when no window is shown", () => {
    const out = renderWaves(waves([job({ resetAt: at(5 * HOUR) })], { maxWindows: 2 }));
    expect(out).toContain(NO_WAVES_MESSAGE);
    expect(out).toContain("beyond the shown horizon");
  });

  it("does not emit ANSI escapes when color is off", () => {
    const out = renderWaves(waves([job()]), { color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no escapes.
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe("renderWavesJson", () => {
  it("emits the store path, histogram, and honest totals", () => {
    const w = waves([job({ id: "j1", resetAt: at(0.5 * HOUR) })]);
    const parsed = JSON.parse(
      renderWavesJson({ storePath: "/tmp/jobs.json", generatedAt: "2026-07-30T10:00:00.000Z", waves: w })
    );
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe("2026-07-30T10:00:00.000Z");
    expect(parsed.waves.totalWaiting).toBe(1);
    expect(parsed.waves.windows[0].count).toBe(1);
  });

  it("includes the scope when one is passed", () => {
    const parsed = JSON.parse(
      renderWavesJson({ storePath: "/tmp/jobs.json", scope: { projects: ["demo"] }, waves: waves([]) })
    );
    expect(parsed.scope).toEqual({ projects: ["demo"] });
  });
});
