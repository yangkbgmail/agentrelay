import { describe, expect, it } from "vitest";
import {
  buildBatchParseReport,
  buildParseReport,
  renderBatchParseReport,
  renderBatchParseReportJson,
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

describe("buildBatchParseReport", () => {
  const CORPUS = [
    "usage limit reached — resets at 2026-07-20T17:00:00Z",
    "", // blank line — skipped, does not count
    "rate limit — try again in 2h30m",
    "Build succeeded in 3.2s", // no match
    "   ", // whitespace-only — skipped
    "resets at 3:00pm",
  ].join("\n");

  it("parses each non-blank line and skips blanks while keeping faithful line numbers", () => {
    const { entries, summary } = buildBatchParseReport(CORPUS, { now: NOW });
    // 4 non-blank lines parsed (lines 1, 3, 4, 6 of the source).
    expect(entries.map((e) => e.line)).toEqual([1, 3, 4, 6]);
    expect(summary.total).toBe(4);
    expect(summary.matched).toBe(3);
    expect(summary.unmatched).toBe(1);
    expect(summary.matchRate).toBe(0.75);
    expect(summary.tool).toBe("generic");
  });

  it("ranks the per-pattern breakdown by count desc then name asc", () => {
    const input = ["try again in 1h", "try again in 30m", "resets at 2026-07-20T17:00:00Z"].join("\n");
    const { summary } = buildBatchParseReport(input, { now: NOW });
    expect(summary.byPattern).toEqual([
      { pattern: "relative-duration", count: 2 },
      { pattern: "iso-timestamp", count: 1 },
    ]);
  });

  it("uses the given tool's adapter patterns across the whole corpus", () => {
    const input = ["Rate limit reached. Please try again in 20s.", "Rate limited, try again in 45s"].join("\n");
    // Generic adapter has no seconds pattern → nothing matches.
    expect(buildBatchParseReport(input, { now: NOW }).summary.matched).toBe(0);
    // Codex adapter recognizes bare-seconds waits on every line.
    const { summary } = buildBatchParseReport(input, { tool: "codex-cli", now: NOW });
    expect(summary.matched).toBe(2);
    expect(summary.byPattern).toEqual([{ pattern: "codex-relative-seconds", count: 2 }]);
  });

  it("reports total 0 and null matchRate for empty/blank input", () => {
    const { entries, summary } = buildBatchParseReport("\n   \n\t\n", { now: NOW });
    expect(entries).toEqual([]);
    expect(summary.total).toBe(0);
    expect(summary.matchRate).toBeNull();
    expect(summary.byPattern).toEqual([]);
  });
});

describe("renderBatchParseReport", () => {
  it("renders a marker per line plus a summary footer and pattern breakdown", () => {
    const result = buildBatchParseReport(["try again in 1h", "just a normal log line"].join("\n"), { now: NOW });
    const out = renderBatchParseReport(result, { now: NOW_MS, color: false });
    expect(out).toContain("✓");
    expect(out).toContain("·");
    expect(out).toContain("relative-duration");
    expect(out).toContain("resets in 1h 0m");
    expect(out).toContain("no match");
    expect(out).toContain("2 message(s)");
    expect(out).toContain("1 matched (50%)");
    expect(out).toContain("1 unmatched");
    expect(out).toContain("By pattern:");
  });

  it("shows a placeholder for empty input and no ANSI when color is false", () => {
    const empty = renderBatchParseReport(buildBatchParseReport("", { now: NOW }), { now: NOW_MS, color: false });
    expect(empty).toContain("No messages to parse");
    expect(empty).not.toContain("\x1b[");
    const colored = renderBatchParseReport(buildBatchParseReport("try again in 1h", { now: NOW }), {
      now: NOW_MS,
      color: true,
    });
    expect(colored).toContain("\x1b[");
  });
});

describe("renderBatchParseReportJson", () => {
  it("emits the summary and per-line entries with resetInMs", () => {
    const result = buildBatchParseReport(["try again in 30m", "nothing here"].join("\n"), { now: NOW });
    const parsed = JSON.parse(renderBatchParseReportJson(result, { now: NOW_MS }));
    expect(parsed.summary.total).toBe(2);
    expect(parsed.summary.matched).toBe(1);
    expect(parsed.summary.matchRate).toBe(0.5);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toMatchObject({
      line: 1,
      text: "try again in 30m",
      matched: true,
      pattern: "relative-duration",
      resetInMs: 30 * 60_000,
    });
    expect(parsed.entries[1]).toMatchObject({ line: 2, matched: false, resetInMs: null });
  });
});
