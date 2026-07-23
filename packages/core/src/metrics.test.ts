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

  it("emits a resolution_time histogram (bucket/sum/count) when jobs resolved", () => {
    // Spans of 30s, 5m, 2h. Sum = 7,530 s. Cumulative: 1 ≤ 1m, 2 ≤ 5m, 3 ≤ 3h.
    const jobs = [
      job({ createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:30.000Z" }),
      job({ createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:05:00.000Z" }),
      job({ createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T02:00:00.000Z" }),
    ];
    const text = renderPrometheusMetrics(computeStats(jobs));
    expect(text).toContain("# TYPE agentrelay_resolution_time_seconds histogram");
    const s = parseSamples(text);
    // `le` boundaries are rendered in seconds.
    expect(s.get('agentrelay_resolution_time_seconds_bucket{le="60"}')).toBe(1);
    expect(s.get('agentrelay_resolution_time_seconds_bucket{le="300"}')).toBe(2);
    expect(s.get('agentrelay_resolution_time_seconds_bucket{le="3600"}')).toBe(2);
    expect(s.get('agentrelay_resolution_time_seconds_bucket{le="10800"}')).toBe(3);
    expect(s.get('agentrelay_resolution_time_seconds_bucket{le="+Inf"}')).toBe(3);
    expect(s.get("agentrelay_resolution_time_seconds_sum")).toBe(7530);
    expect(s.get("agentrelay_resolution_time_seconds_count")).toBe(3);
    // The histogram base name must not collide with the quantile gauge family.
    expect(text).toContain("# TYPE agentrelay_resolution_seconds gauge");
  });

  it("omits the resolution_time histogram when nothing has resolved", () => {
    const text = renderPrometheusMetrics(computeStats([job({ status: "queued" })]));
    expect(text).not.toContain("agentrelay_resolution_time_seconds");
  });

  it("honors a custom prefix and sanitizes it", () => {
    const text = renderPrometheusMetrics(computeStats([job()]), { prefix: "my-relay" });
    expect(text).toContain("my_relay_jobs ");
    expect(text).not.toContain("agentrelay_jobs ");
  });
});
