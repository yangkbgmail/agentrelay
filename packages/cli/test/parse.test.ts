import { describe, expect, it } from "vitest";
import { buildParseReport, classifyReport, renderParseReport, renderParseReportJson } from "../src/parse.js";

const DAY = 24 * 60 * 60_000;
const HORIZON = 8 * DAY; // matches core DEFAULT_MAX_RESET_HORIZON_MS / PAST

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

  it("includes a plausibility field driven by the horizons", () => {
    const near = buildParseReport("try again in 2h", { now: NOW });
    expect(
      JSON.parse(renderParseReportJson(near, { now: NOW_MS, maxFutureMs: HORIZON, maxPastMs: HORIZON })).plausibility
    ).toBe("ok");

    const far = buildParseReport("resets at 2026-09-30T12:00:00Z", { now: NOW }); // ~72 days out
    expect(
      JSON.parse(renderParseReportJson(far, { now: NOW_MS, maxFutureMs: HORIZON, maxPastMs: HORIZON })).plausibility
    ).toBe("too-far-future");

    const noMatch = buildParseReport("all good", { now: NOW });
    expect(
      JSON.parse(renderParseReportJson(noMatch, { now: NOW_MS, maxFutureMs: HORIZON, maxPastMs: HORIZON })).plausibility
    ).toBeNull();
  });
});

describe("classifyReport", () => {
  it("classifies against the supplied horizons and null when unusable", () => {
    const near = buildParseReport("try again in 3h", { now: NOW });
    expect(classifyReport(near, { now: NOW_MS, maxFutureMs: HORIZON, maxPastMs: HORIZON })).toBe("ok");

    const far = buildParseReport("resets at 2026-08-30T12:00:00Z", { now: NOW }); // >8 days out
    expect(classifyReport(far, { now: NOW_MS, maxFutureMs: HORIZON, maxPastMs: HORIZON })).toBe("too-far-future");

    // A far-past absolute timestamp (e.g. an epoch-unit misparse) reads as a misparse.
    const past = buildParseReport("resets at 2026-01-01T00:00:00Z", { now: NOW });
    expect(classifyReport(past, { now: NOW_MS, maxFutureMs: HORIZON, maxPastMs: HORIZON })).toBe("too-far-past");

    const noMatch = buildParseReport("nothing here", { now: NOW });
    expect(classifyReport(noMatch, { now: NOW_MS, maxFutureMs: HORIZON, maxPastMs: HORIZON })).toBeNull();
  });
});

describe("renderParseReport plausibility annotation", () => {
  it("warns and names the env var when the reset overshoots the future horizon", () => {
    const far = buildParseReport("resets at 2026-09-30T12:00:00Z", { now: NOW });
    const out = renderParseReport(far, { now: NOW_MS, color: false, maxFutureMs: HORIZON, maxPastMs: HORIZON });
    expect(out).toContain("beyond the reset horizon");
    expect(out).toContain("AGENTRELAY_MAX_RESET_HORIZON");
  });

  it("warns that a far-past reset is likely a misparse", () => {
    const past = buildParseReport("resets at 2026-01-01T00:00:00Z", { now: NOW });
    const out = renderParseReport(past, { now: NOW_MS, color: false, maxFutureMs: HORIZON, maxPastMs: HORIZON });
    expect(out).toContain("in the past");
    expect(out).toContain("misparse");
  });

  it("adds no annotation for a plausible reset", () => {
    const near = buildParseReport("try again in 2h", { now: NOW });
    const out = renderParseReport(near, { now: NOW_MS, color: false, maxFutureMs: HORIZON, maxPastMs: HORIZON });
    expect(out).not.toContain("⚠");
  });

  it("adds no future annotation when the horizon guard is disabled", () => {
    const far = buildParseReport("resets at 2026-09-30T12:00:00Z", { now: NOW });
    const out = renderParseReport(far, { now: NOW_MS, color: false, maxFutureMs: null, maxPastMs: HORIZON });
    expect(out).not.toContain("beyond the reset horizon");
  });
});
