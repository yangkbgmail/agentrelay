import type { RelayJob } from "@agentrelay/core";
import { computeResumeForecast } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  NO_FORECAST_JOBS_MESSAGE,
  NO_SCOPE_MATCH_MESSAGE,
  NO_WAITING_MESSAGE,
  renderForecast,
  renderForecastJson,
} from "../src/forecast.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `abcdef${seq}0000`,
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "waiting_for_reset",
    resetAt: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-12T12:00:00.000Z");
const HOUR = 60 * 60_000;
const at = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

describe("renderForecast", () => {
  it("shows the onboarding message for an empty store", () => {
    const out = renderForecast(computeResumeForecast([], { now: NOW }), { now: NOW, total: 0 });
    expect(out).toBe(NO_FORECAST_JOBS_MESSAGE);
  });

  it("shows the no-match message for an empty scoped subset", () => {
    const out = renderForecast(computeResumeForecast([], { now: NOW }), {
      now: NOW,
      total: 0,
      scopeNote: "tool=codex-cli",
    });
    expect(out).toContain("scope: tool=codex-cli");
    expect(out).toContain(NO_SCOPE_MATCH_MESSAGE);
  });

  it("shows the nothing-waiting message when jobs exist but none wait", () => {
    const out = renderForecast(computeResumeForecast([job({ status: "completed", resetAt: null })], { now: NOW }), {
      now: NOW,
      total: 1,
    });
    expect(out).toContain(NO_WAITING_MESSAGE);
  });

  it("groups upcoming resumes under their time horizons with a countdown", () => {
    const jobs = [
      job({ id: "overdue00", resetAt: at(-5 * 60_000) }),
      job({ id: "soon0000", resetAt: at(30 * 60_000) }),
      job({ id: "later000", resetAt: at(12 * HOUR) }),
    ];
    const out = renderForecast(computeResumeForecast(jobs, { now: NOW }), { now: NOW, total: jobs.length });
    expect(out).toContain("3 resume(s) scheduled");
    expect(out).toContain("(1 due now)");
    expect(out).toContain("due now");
    expect(out).toContain("within 1h");
    expect(out).toContain("within 24h");
    // Short ids (8 chars) are shown.
    expect(out).toContain("overdue0");
    expect(out).toContain("soon0000");
  });

  it("reports both the next reset and when the queue drains when they differ", () => {
    const jobs = [job({ id: "first000", resetAt: at(HOUR) }), job({ id: "last0000", resetAt: at(6 * HOUR) })];
    const out = renderForecast(computeResumeForecast(jobs, { now: NOW }), { now: NOW, total: jobs.length });
    expect(out).toContain(`next reset: ${at(HOUR)}`);
    expect(out).toContain(`queue drains: ${at(6 * HOUR)}`);
  });

  it("omits the drain line when only one job waits", () => {
    const jobs = [job({ id: "only0000", resetAt: at(HOUR) })];
    const out = renderForecast(computeResumeForecast(jobs, { now: NOW }), { now: NOW, total: jobs.length });
    expect(out).toContain("next reset:");
    expect(out).not.toContain("queue drains:");
  });

  it("elides events beyond the per-bucket cap with a '… N more' line", () => {
    const jobs = Array.from({ length: 7 }, (_, i) => job({ id: `j${i}000000`, resetAt: at(10 * 60_000 + i) }));
    const out = renderForecast(computeResumeForecast(jobs, { now: NOW }), { now: NOW, total: jobs.length });
    expect(out).toContain("… 2 more"); // 7 events, cap 5
  });
});

describe("renderForecastJson", () => {
  it("wraps the forecast in a stable envelope", () => {
    const forecast = computeResumeForecast([job({ id: "q0000000", resetAt: at(HOUR) })], { now: NOW });
    const json = renderForecastJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-12T12:00:00.000Z",
      forecast,
    });
    const parsed = JSON.parse(json);
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.scope).toBeUndefined();
    expect(parsed.forecast.waiting).toBe(1);
    expect(parsed.forecast.events[0].jobId).toBe("q0000000");
  });

  it("includes the scope when one is active", () => {
    const json = renderForecastJson({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-07-12T12:00:00.000Z",
      scope: { statuses: ["waiting_for_reset"] },
      forecast: computeResumeForecast([], { now: NOW }),
    });
    expect(JSON.parse(json).scope).toEqual({ statuses: ["waiting_for_reset"] });
  });
});
