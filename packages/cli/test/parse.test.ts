import { describe, expect, it } from "vitest";
import {
  buildParseReport,
  buildScanReport,
  renderParseReport,
  renderParseReportJson,
  renderScanReport,
  renderScanReportJson,
} from "../src/parse.js";

const NOW = new Date("2026-07-20T12:00:00.000Z");
const NOW_MS = NOW.getTime();

describe("buildParseReport", () => {
  it("detects an explicit ISO reset timestamp with the generic adapter", () => {
    const report = buildParseReport("usage limit reached — resets at 2026-07-20T17:00:00Z", { now: NOW });
    expect(report.matched).toBe(true);
    expect(report.tool).toBe("generic");
    expect(report.pattern).toBe("iso-timestamp");
    expect(report.resetAt).toBe("2026-07-20T17:00:00.000Z");
    expect(report.rawMatch).toContain("2026-07-20T17:00:00Z");
  });

  it("resolves a relative duration against the injected now", () => {
    const report = buildParseReport("rate limit — try again in 2h30m", { now: NOW });
    expect(report.matched).toBe(true);
    expect(report.pattern).toBe("relative-duration");
    expect(report.resetAt).toBe(new Date(NOW_MS + (2 * 60 + 30) * 60_000).toISOString());
  });

  it("reports no match for a non-rate-limit message", () => {
    const report = buildParseReport("Build succeeded in 3.2s", { now: NOW });
    expect(report.matched).toBe(false);
    expect(report.resetAt).toBeNull();
    expect(report.rawMatch).toBeNull();
    expect(report.pattern).toBeNull();
    // Adapter still reported so the caller can show which patterns were tried.
    expect(report.tool).toBe("generic");
  });

  it("uses the codex adapter's seconds pattern that the generic parser misses", () => {
    const message = "Rate limit reached. Please try again in 20s.";
    // Generic adapter has no seconds pattern → no match.
    expect(buildParseReport(message, { now: NOW }).matched).toBe(false);
    // Codex adapter recognizes bare-seconds waits.
    const report = buildParseReport(message, { tool: "codex-cli", now: NOW });
    expect(report.matched).toBe(true);
    expect(report.tool).toBe("codex-cli");
    expect(report.pattern).toBe("codex-relative-seconds");
    expect(report.resetAt).toBe(new Date(NOW_MS + 20_000).toISOString());
  });

  it("falls back to the generic adapter for an unknown/omitted tool", () => {
    const report = buildParseReport("resets at 3:00pm", { now: NOW });
    expect(report.tool).toBe("generic");
    expect(report.pattern).toBe("clock-time");
  });
});

describe("renderParseReport", () => {
  it("renders a no-match message that names the adapter", () => {
    const report = buildParseReport("all good here", { now: NOW });
    const out = renderParseReport(report, { now: NOW_MS, color: false });
    expect(out).toContain("No rate-limit detected");
    expect(out).toContain("adapter: generic");
    expect(out).not.toContain("resets:");
  });

  it("renders a match with pattern, matched substring, reset time and countdown", () => {
    const report = buildParseReport("usage limit — try again in 1h", { now: NOW });
    const out = renderParseReport(report, { now: NOW_MS, color: false });
    expect(out).toContain("Rate limit detected");
    expect(out).toContain("relative-duration");
    expect(out).toContain(report.resetAt as string);
    expect(out).toContain("(in 1h 0m)");
  });

  it("omits ANSI codes when color is false and includes them when true", () => {
    const report = buildParseReport("try again in 1h", { now: NOW });
    expect(renderParseReport(report, { now: NOW_MS, color: false })).not.toContain("\x1b[");
    expect(renderParseReport(report, { now: NOW_MS, color: true })).toContain("\x1b[");
  });
});

describe("renderParseReportJson", () => {
  it("emits resetInMs alongside the report fields for a match", () => {
    const report = buildParseReport("try again in 30m", { now: NOW });
    const parsed = JSON.parse(renderParseReportJson(report, { now: NOW_MS }));
    expect(parsed.matched).toBe(true);
    expect(parsed.pattern).toBe("relative-duration");
    expect(parsed.resetInMs).toBe(30 * 60_000);
  });

  it("emits null resetInMs when there is no match", () => {
    const report = buildParseReport("nothing to see", { now: NOW });
    const parsed = JSON.parse(renderParseReportJson(report, { now: NOW_MS }));
    expect(parsed.matched).toBe(false);
    expect(parsed.resetAt).toBeNull();
    expect(parsed.resetInMs).toBeNull();
  });
});

describe("buildScanReport", () => {
  const LOG = [
    "Starting agent run...",
    "Working on task",
    "Error: usage limit reached — resets at 2026-07-20T17:00:00Z",
    "Retrying...",
    "rate limit again — try again in 30m",
    "done",
  ].join("\n");

  it("reports every matching line with its 1-based line number", () => {
    const report = buildScanReport(LOG, { now: NOW });
    expect(report.totalLines).toBe(6);
    expect(report.tool).toBe("generic");
    expect(report.matches).toHaveLength(2);
    expect(report.matches[0].line).toBe(3);
    expect(report.matches[0].pattern).toBe("iso-timestamp");
    expect(report.matches[0].resetAt).toBe("2026-07-20T17:00:00.000Z");
    expect(report.matches[1].line).toBe(5);
    expect(report.matches[1].pattern).toBe("relative-duration");
  });

  it("marks the first match as the line AgentRelay would act on", () => {
    const report = buildScanReport(LOG, { now: NOW });
    expect(report.actsOnLine).toBe(3);
  });

  it("returns no matches and null actsOnLine for a clean log", () => {
    const report = buildScanReport("all fine\nbuild ok\n", { now: NOW });
    expect(report.totalLines).toBe(2);
    expect(report.matches).toHaveLength(0);
    expect(report.actsOnLine).toBeNull();
  });

  it("does not count a trailing newline as an extra line", () => {
    expect(buildScanReport("one\ntwo\n", { now: NOW }).totalLines).toBe(2);
    expect(buildScanReport("one\ntwo", { now: NOW }).totalLines).toBe(2);
  });

  it("strips a trailing CR from CRLF input so the matched text is clean", () => {
    const report = buildScanReport("try again in 1h\r\nnext", { now: NOW });
    expect(report.matches).toHaveLength(1);
    expect(report.matches[0].text).toBe("try again in 1h");
    expect(report.matches[0].line).toBe(1);
  });

  it("honors the tool adapter so codex seconds match line-by-line", () => {
    const report = buildScanReport("busy\nPlease try again in 20s.\n", { tool: "codex-cli", now: NOW });
    expect(report.tool).toBe("codex-cli");
    expect(report.matches).toHaveLength(1);
    expect(report.matches[0].pattern).toBe("codex-relative-seconds");
    expect(report.matches[0].resetAt).toBe(new Date(NOW_MS + 20_000).toISOString());
  });
});

describe("renderScanReport", () => {
  it("lists each match with its line number and an arrow on the acted-on line", () => {
    const report = buildScanReport("noise\nresets at 2026-07-20T17:00:00Z\ntry again in 30m", { now: NOW });
    const out = renderScanReport(report, { now: NOW_MS, color: false });
    expect(out).toContain("Detected 2 rate-limit lines of 3 scanned");
    expect(out).toContain("line 2");
    expect(out).toContain("line 3");
    expect(out).toContain("→");
    expect(out).toContain("would act on the first match (line 2)");
  });

  it("renders a no-match summary that names the adapter", () => {
    const report = buildScanReport("all good\nstill good", { now: NOW });
    const out = renderScanReport(report, { now: NOW_MS, color: false });
    expect(out).toContain("No rate-limit lines detected across 2 lines");
    expect(out).toContain("adapter: generic");
  });

  it("omits ANSI codes when color is false and includes them when true", () => {
    const report = buildScanReport("try again in 1h", { now: NOW });
    expect(renderScanReport(report, { now: NOW_MS, color: false })).not.toContain("\x1b[");
    expect(renderScanReport(report, { now: NOW_MS, color: true })).toContain("\x1b[");
  });
});

describe("renderScanReportJson", () => {
  it("emits per-match resetInMs and the totals", () => {
    const report = buildScanReport("noise\ntry again in 30m", { now: NOW });
    const parsed = JSON.parse(renderScanReportJson(report, { now: NOW_MS }));
    expect(parsed.totalLines).toBe(2);
    expect(parsed.actsOnLine).toBe(2);
    expect(parsed.matches).toHaveLength(1);
    expect(parsed.matches[0].line).toBe(2);
    expect(parsed.matches[0].resetInMs).toBe(30 * 60_000);
  });
});
