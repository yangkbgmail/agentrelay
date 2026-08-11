import { describe, expect, it } from "vitest";
import { buildParseReport, buildScanReport, renderScanReport, renderScanReportJson } from "./parse.js";

// A fixed "now" so reset resolution and countdowns are deterministic.
const NOW = new Date("2026-08-10T12:00:00.000Z");
const NOW_MS = NOW.getTime();

describe("buildParseReport (single-message, unchanged)", () => {
  it("detects a relative-duration limit", () => {
    const report = buildParseReport("Error: rate limit reached, try again in 2h", { now: NOW });
    expect(report.matched).toBe(true);
    expect(report.pattern).toBe("relative-duration");
    expect(report.resetAt).toBe("2026-08-10T14:00:00.000Z");
  });

  it("reports no match for ordinary output", () => {
    const report = buildParseReport("Build succeeded in 3.2s", { now: NOW });
    expect(report.matched).toBe(false);
    expect(report.pattern).toBeNull();
  });
});

describe("buildScanReport", () => {
  it("reports one match per line and skips blank lines", () => {
    const log = [
      "starting task...",
      "Error: rate limit reached, try again in 2h",
      "",
      "   ",
      "usage limit hit — resets in 30m",
      "done for now",
    ].join("\n");

    const report = buildScanReport(log, { now: NOW });
    // 4 non-blank lines scanned (two blank/whitespace lines skipped).
    expect(report.scannedLines).toBe(4);
    expect(report.matches).toHaveLength(2);
    expect(report.matches[0]).toMatchObject({ line: 2, pattern: "relative-duration" });
    expect(report.matches[0].resetAt).toBe("2026-08-10T14:00:00.000Z");
    // Line number reflects the *original* input position, blanks included.
    expect(report.matches[1]).toMatchObject({ line: 5, pattern: "relative-duration" });
    expect(report.matches[1].resetAt).toBe("2026-08-10T12:30:00.000Z");
  });

  it("collapses nothing: a multi-line blob that default parse reads as one message still yields per-line hits", () => {
    const log = ["resets in 1h", "resets in 3h"].join("\n");
    // Default single-message parse only sees the first match.
    const single = buildParseReport(log, { now: NOW });
    expect(single.matched).toBe(true);
    // Scan sees both.
    const scan = buildScanReport(log, { now: NOW });
    expect(scan.matches.map((m) => m.line)).toEqual([1, 2]);
  });

  it("ranks the per-pattern frequency table by count desc, then name asc", () => {
    const log = ["try again in 5m", "try again in 10m", "reset at 2026-08-11T00:00:00Z"].join("\n");
    const report = buildScanReport(log, { now: NOW });
    expect(report.byPattern).toEqual([
      { pattern: "relative-duration", count: 2 },
      { pattern: "iso-timestamp", count: 1 },
    ]);
  });

  it("honors the tool adapter (Codex recognizes seconds the generic parser ignores)", () => {
    const log = "please try again in 20s";
    const generic = buildScanReport(log, { now: NOW });
    expect(generic.matches).toHaveLength(0);
    const codex = buildScanReport(log, { tool: "codex-cli", now: NOW });
    expect(codex.matches).toHaveLength(1);
  });

  it("reports zero scanned lines for empty input", () => {
    const report = buildScanReport("", { now: NOW });
    expect(report.scannedLines).toBe(0);
    expect(report.matches).toHaveLength(0);
    expect(report.byPattern).toHaveLength(0);
  });

  it("reports scanned lines but no matches when nothing is rate-limit-y", () => {
    const report = buildScanReport("hello\nworld", { now: NOW });
    expect(report.scannedLines).toBe(2);
    expect(report.matches).toHaveLength(0);
  });
});

describe("renderScanReport", () => {
  it("lists each detection with line number and pattern, plus a summary footer", () => {
    const log = ["try again in 2h", "noise", "resets in 30m"].join("\n");
    const report = buildScanReport(log, { now: NOW });
    const out = renderScanReport(report, { now: NOW_MS, color: false });
    expect(out).toContain("L1");
    expect(out).toContain("L3");
    expect(out).toContain("relative-duration");
    expect(out).toContain("2 detection(s) across 3 line(s)");
    expect(out).toContain("by pattern: relative-duration ×2");
    // No ANSI when color is off.
    expect(out).not.toContain("\x1b[");
  });

  it("shows a no-detections message when scanned lines all miss", () => {
    const report = buildScanReport("hello\nworld", { now: NOW });
    const out = renderScanReport(report, { now: NOW_MS, color: false });
    expect(out).toContain("No rate limits detected across 2 line(s)");
  });

  it("shows an empty-input message when there are no lines", () => {
    const report = buildScanReport("", { now: NOW });
    const out = renderScanReport(report, { now: NOW_MS, color: false });
    expect(out).toContain("No lines to scan");
  });

  it("emits ANSI codes when color is on", () => {
    const report = buildScanReport("try again in 2h", { now: NOW });
    const out = renderScanReport(report, { now: NOW_MS, color: true });
    expect(out).toContain("\x1b[");
  });
});

describe("renderScanReportJson", () => {
  it("adds resetInMs to each match and preserves the report shape", () => {
    const log = ["try again in 2h", "resets in 30m"].join("\n");
    const report = buildScanReport(log, { now: NOW });
    const parsed = JSON.parse(renderScanReportJson(report, { now: NOW_MS }));
    expect(parsed.tool).toBe("generic");
    expect(parsed.scannedLines).toBe(2);
    expect(parsed.matches).toHaveLength(2);
    expect(parsed.matches[0].resetInMs).toBe(2 * 60 * 60 * 1000);
    expect(parsed.matches[1].resetInMs).toBe(30 * 60 * 1000);
    expect(parsed.byPattern).toEqual([{ pattern: "relative-duration", count: 2 }]);
  });
});
