import { describe, expect, it } from "vitest";
import { buildParseReport, renderParseReport, renderParseReportJson } from "../src/parse.js";

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
