import type { RateLimitDetection, RelayJob } from "@agentrelay/core";
import { buildRelayReport } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { EMPTY_REPORT_MESSAGE, NO_SCOPE_MATCH_MESSAGE, renderReport, renderReportJson } from "../src/report.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}${"0".repeat(8)}`,
    project: "proj",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:05:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function detection(overrides: Partial<RateLimitDetection> = {}): RateLimitDetection {
  return {
    pattern: "clock-time",
    rawMatch: "resets at 5pm",
    resetAt: "2026-07-13T17:00:00.000Z",
    detectedAt: "2026-07-13T12:00:00.000Z",
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-13T12:00:00.000Z");

describe("renderReport", () => {
  it("shows the empty message on a store with no jobs", () => {
    const report = buildRelayReport([], { nowMs: NOW });
    const out = renderReport(report);
    expect(out).toContain(EMPTY_REPORT_MESSAGE);
    expect(out).toContain("AgentRelay report");
  });

  it("switches to the no-match message when a scope is active", () => {
    const report = buildRelayReport([], { nowMs: NOW });
    const out = renderReport(report, { scopeNote: "status=failed" });
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
    expect(out).toContain("scope: status=failed");
    expect(out).not.toContain(EMPTY_REPORT_MESSAGE);
  });

  it("renders the four sections with headline numbers", () => {
    const jobs = [
      job({ status: "completed" }),
      job({ status: "completed" }),
      job({ status: "failed", lastError: "spawn ENOENT" }),
      job({ status: "waiting_for_reset", resetAt: "2026-07-13T17:00:00.000Z", lastRateLimit: detection() }),
    ];
    const report = buildRelayReport(jobs, { nowMs: NOW });
    const out = renderReport(report);

    expect(out).toContain("4 job(s) tracked");
    expect(out).toContain("success rate: 67%"); // 2 completed / 3 resolved
    expect(out).toContain("next resume");
    expect(out).toContain("resets in");
    expect(out).toContain("top errors");
    expect(out).toContain("spawn ENOENT");
    expect(out).toContain("top rate-limit patterns");
    expect(out).toContain("clock-time");
  });

  it("notes when there are no errors and no detections", () => {
    const report = buildRelayReport([job({ status: "completed" })], { nowMs: NOW });
    const out = renderReport(report);
    expect(out).toContain("none — no jobs have recorded an error");
    expect(out).toContain("none — no rate-limit detections recorded");
    expect(out).toContain("none waiting for a reset");
  });

  it("shows a hidden-reasons footer when errors exceed the top cap", () => {
    const jobs = Array.from({ length: 8 }, (_, i) => job({ status: "failed", lastError: `reason ${i}` }));
    const report = buildRelayReport(jobs, { nowMs: NOW, topErrors: 3, topPatterns: 3 });
    const out = renderReport(report);
    expect(out).toContain("8 job(s) with errors across 8 distinct reason(s)");
    expect(out).toContain("more reason(s)");
  });

  it("omits ANSI codes unless color is enabled", () => {
    const report = buildRelayReport([job({ status: "failed", lastError: "boom" })], { nowMs: NOW });
    const plain = renderReport(report, { color: false });
    const colored = renderReport(report, { color: true });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI escapes are absent
    expect(plain).not.toMatch(/\x1b\[/);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI escapes are present
    expect(colored).toMatch(/\x1b\[/);
  });
});

describe("renderReportJson", () => {
  it("emits the report verbatim with store and scope", () => {
    const report = buildRelayReport([job({ status: "completed" })], { nowMs: NOW });
    const parsed = JSON.parse(renderReportJson(report, "/tmp/jobs.json", { scopeNote: "tool=claude-code" }));
    expect(parsed.store).toBe("/tmp/jobs.json");
    expect(parsed.scope).toBe("tool=claude-code");
    expect(parsed.report.totalJobs).toBe(1);
    expect(parsed.report.stats.total).toBe(1);
    expect(parsed.report.generatedAtMs).toBe(NOW);
  });

  it("sets scope to null when no scope is active", () => {
    const report = buildRelayReport([], { nowMs: NOW });
    const parsed = JSON.parse(renderReportJson(report, "/tmp/jobs.json"));
    expect(parsed.scope).toBeNull();
  });
});
