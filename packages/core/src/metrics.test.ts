import { describe, expect, it } from "vitest";
import { escapePrometheusLabel, renderPrometheusMetrics, sanitizeMetricPrefix } from "./metrics.js";
import { computeStats } from "./stats.js";
import type { AgentTool, JobStatus, RelayJob } from "./types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "proj",
    tool: "claude-code" as AgentTool,
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "completed" as JobStatus,
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

/** Parse `name{a="b"} 12` sample lines into a map keyed by the full `name{...}`. */
function parseSamples(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const idx = line.lastIndexOf(" ");
    out.set(line.slice(0, idx), Number(line.slice(idx + 1)));
  }
  return out;
}

describe("escapePrometheusLabel", () => {
  it("escapes backslash, double quote and newline", () => {
    expect(escapePrometheusLabel('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');
  });
  it("leaves ordinary text untouched", () => {
    expect(escapePrometheusLabel("claude-code")).toBe("claude-code");
  });
});

describe("sanitizeMetricPrefix", () => {
  it("keeps a valid prefix", () => {
    expect(sanitizeMetricPrefix("agentrelay")).toBe("agentrelay");
    expect(sanitizeMetricPrefix("my_relay:v2")).toBe("my_relay:v2");
  });
  it("replaces invalid characters with underscore", () => {
    expect(sanitizeMetricPrefix("my-relay.app")).toBe("my_relay_app");
  });
  it("guards a leading digit", () => {
    expect(sanitizeMetricPrefix("2relay")).toBe("_2relay");
  });
  it("falls back to the default for an all-invalid prefix", () => {
    expect(sanitizeMetricPrefix("!!!")).toBe("___");
    expect(sanitizeMetricPrefix("")).toBe("agentrelay");
  });
});

describe("renderPrometheusMetrics", () => {
  it("emits an empty-store shape with zero-filled status/tool gauges", () => {
    const text = renderPrometheusMetrics(computeStats([]));
    const s = parseSamples(text);
    expect(s.get("agentrelay_jobs")).toBe(0);
    expect(s.get('agentrelay_jobs_by_status{status="completed"}')).toBe(0);
    expect(s.get('agentrelay_jobs_by_tool{tool="generic"}')).toBe(0);
    expect(s.get("agentrelay_jobs_active")).toBe(0);
    expect(s.get("agentrelay_resolved_jobs")).toBe(0);
    // No resolution/success-rate samples when nothing has resolved.
    expect(text).not.toContain("agentrelay_success_rate");
    expect(text).not.toContain("agentrelay_resolution_seconds");
  });

  it("ends with a trailing newline and has a HELP/TYPE header per family", () => {
    const text = renderPrometheusMetrics(computeStats([job()]));
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain("# HELP agentrelay_jobs ");
    expect(text).toContain("# TYPE agentrelay_jobs gauge");
  });

  it("counts jobs by status, tool, active/terminal, attempts and retries", () => {
    const jobs = [
      job({ status: "completed", tool: "claude-code", attempts: 3 }),
      job({ status: "failed", tool: "codex-cli", attempts: 2 }),
      job({ status: "queued", tool: "generic", attempts: 1 }),
      job({ status: "cancelled", tool: "claude-code", attempts: 1 }),
    ];
    const s = parseSamples(renderPrometheusMetrics(computeStats(jobs)));
    expect(s.get("agentrelay_jobs")).toBe(4);
    expect(s.get('agentrelay_jobs_by_status{status="completed"}')).toBe(1);
    expect(s.get('agentrelay_jobs_by_status{status="cancelled"}')).toBe(1);
    expect(s.get('agentrelay_jobs_by_tool{tool="claude-code"}')).toBe(2);
    expect(s.get("agentrelay_jobs_active")).toBe(1);
    expect(s.get("agentrelay_jobs_terminal")).toBe(3);
    expect(s.get("agentrelay_attempts")).toBe(7);
    expect(s.get("agentrelay_retried_jobs")).toBe(2);
  });

  it("emits success_rate only when jobs have resolved", () => {
    const jobs = [job({ status: "completed" }), job({ status: "failed" })];
    const s = parseSamples(renderPrometheusMetrics(computeStats(jobs)));
    expect(s.get("agentrelay_success_rate")).toBe(0.5);
  });

  it("emits resolution_seconds in seconds when jobs resolved", () => {
    // 60_000 ms span → 60 seconds.
    const jobs = [
      job({
        status: "completed",
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:01:00.000Z",
      }),
    ];
    const s = parseSamples(renderPrometheusMetrics(computeStats(jobs)));
    expect(s.get("agentrelay_resolved_jobs")).toBe(1);
    expect(s.get('agentrelay_resolution_seconds{stat="avg"}')).toBe(60);
    expect(s.get('agentrelay_resolution_seconds{stat="p90"}')).toBe(60);
  });

  it("exposes the full resolution distribution and spread widths", () => {
    // Three jobs with spans of 1h, 3h and 9h → percentiles and spread are all
    // defined (in seconds: 3600, 10800, 32400).
    const jobs = [
      job({ createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T01:00:00.000Z" }),
      job({ createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T03:00:00.000Z" }),
      job({ createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T09:00:00.000Z" }),
    ];
    const text = renderPrometheusMetrics(computeStats(jobs));
    const s = parseSamples(text);
    expect(s.get('agentrelay_resolution_seconds{stat="min"}')).toBe(3600);
    expect(s.get('agentrelay_resolution_seconds{stat="median"}')).toBe(10800);
    expect(s.get('agentrelay_resolution_seconds{stat="max"}')).toBe(32400);
    // Every distribution + spread stat is present when jobs resolved.
    for (const st of ["p25", "avg", "p75", "p90", "p95", "p99", "iqr", "stdev", "mad"]) {
      expect(s.has(`agentrelay_resolution_seconds{stat="${st}"}`)).toBe(true);
    }
    // CV lives in its own dimensionless family.
    expect(s.has("agentrelay_resolution_cv")).toBe(true);
  });

  it("omits resolution_cv when the mean resolution is 0 (all zero-span)", () => {
    // Two same-instant (zero-span) resolutions → mean 0 → CV undefined (null).
    const jobs = [
      job({ createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z" }),
      job({ createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z" }),
    ];
    const text = renderPrometheusMetrics(computeStats(jobs));
    // resolution_seconds is still emitted (spans are valid, just zero)…
    expect(text).toContain("agentrelay_resolution_seconds");
    // …but CV is omitted rather than emitting NaN.
    expect(text).not.toContain("agentrelay_resolution_cv");
  });

  it("emits next_reset_timestamp_seconds as absolute epoch seconds for the soonest reset", () => {
    const resetAt = "2026-07-13T02:00:00.000Z";
    const expectedEpoch = Date.parse(resetAt) / 1000; // 1_784_685_600
    const jobs = [
      job({ status: "waiting_for_reset", resetAt: "2026-07-13T05:00:00.000Z" }),
      job({ status: "waiting_for_reset", resetAt }),
    ];
    const s = parseSamples(renderPrometheusMetrics(computeStats(jobs)));
    expect(s.get("agentrelay_next_reset_timestamp_seconds")).toBe(expectedEpoch);
  });

  it("omits next_reset_timestamp_seconds when no job is waiting on a reset", () => {
    const text = renderPrometheusMetrics(computeStats([job({ status: "completed" })]));
    expect(text).not.toContain("agentrelay_next_reset_timestamp_seconds");
  });

  it("honors a custom prefix and sanitizes it", () => {
    const text = renderPrometheusMetrics(computeStats([job()]), { prefix: "my-relay" });
    expect(text).toContain("my_relay_jobs ");
    expect(text).not.toContain("agentrelay_jobs ");
  });
});
