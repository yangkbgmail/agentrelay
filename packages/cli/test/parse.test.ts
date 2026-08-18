import { describe, expect, it } from "vitest";
import {
  buildExplainReport,
  buildParseReport,
  renderExplainReport,
  renderExplainReportJson,
  renderParseReport,
  renderParseReportJson,
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

describe("buildExplainReport", () => {
  it("carries the resolved adapter and the full pattern trace", () => {
    const { tool, report } = buildExplainReport("usage limit — try again in 20s", { tool: "codex-cli", now: NOW });
    expect(tool).toBe("codex-cli");
    expect(report.selectedPattern).toBe("codex-relative-seconds");
    // Adapter pattern is listed first, ahead of the generics.
    expect(report.traces[0]?.name).toBe("codex-relative-seconds");
    expect(report.traces[0]?.source).toBe("adapter");
  });
});

describe("renderExplainReport", () => {
  it("lists the selected pattern with its reset and the tried/skipped others", () => {
    const data = buildExplainReport("usage limit resets at 2026-07-20T17:00:00Z", { now: NOW });
    const out = renderExplainReport(data, { now: NOW_MS, color: false });
    expect(out).toContain("Rate limit detected");
    expect(out).toContain("pattern: iso-timestamp");
    expect(out).toContain("✓ iso-timestamp");
    expect(out).toContain("(in 5h 0m)");
    // Patterns whose regex never matched are shown as "no match".
    expect(out).toContain("no match");
  });

  it("explains a no-match by showing the pre-filter verdict", () => {
    const data = buildExplainReport("Build succeeded in 3.2s", { now: NOW });
    const out = renderExplainReport(data, { now: NOW_MS, color: false });
    expect(out).toContain("No rate-limit detected");
    expect(out).toContain("not rate-limit-y");
  });

  it("labels an implausibly-far reset as rejected by the horizon guard", () => {
    // The core parser applies no horizon by default from this path, so drive it
    // through a message whose reset resolves but is skipped for another reason:
    // a generic regex hit while the pre-filter never tripped.
    const data = buildExplainReport("quota bumped to 5-hour limit next week", { now: NOW });
    const out = renderExplainReport(data, { now: NOW_MS, color: false });
    expect(out).toContain("No rate-limit detected");
    expect(out).toContain("✗ five-hour-window-fallback");
    expect(out).toContain("isn't rate-limit-y");
  });

  it("omits ANSI when color is false and includes it when true", () => {
    const data = buildExplainReport("try again in 1h", { now: NOW });
    expect(renderExplainReport(data, { now: NOW_MS, color: false })).not.toContain("\x1b[");
    expect(renderExplainReport(data, { now: NOW_MS, color: true })).toContain("\x1b[");
  });
});

describe("renderExplainReportJson", () => {
  it("emits per-trace resetInMs and the top-level selection fields", () => {
    const data = buildExplainReport("try again in 30m", { now: NOW });
    const parsed = JSON.parse(renderExplainReportJson(data, { now: NOW_MS }));
    expect(parsed.tool).toBe("generic");
    expect(parsed.matched).toBe(true);
    expect(parsed.selectedPattern).toBe("relative-duration");
    const selected = parsed.traces.find((t: { selected: boolean }) => t.selected);
    expect(selected.name).toBe("relative-duration");
    expect(selected.resetInMs).toBe(30 * 60_000);
    // Non-matching traces carry null resetInMs.
    const noMatch = parsed.traces.find((t: { name: string }) => t.name === "iso-timestamp");
    expect(noMatch.regexMatched).toBe(false);
    expect(noMatch.resetInMs).toBeNull();
  });
});
