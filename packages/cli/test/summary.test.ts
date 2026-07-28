import type { RelayJob } from "@agentrelay/core";
import { summarizeJobs } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_STATUSES,
  isSummaryField,
  nextResetInMs,
  renderSummaryJson,
  renderSummaryLine,
  SUMMARY_FIELDS,
  summaryFieldValue,
} from "../src/summary.js";

const NOW = Date.parse("2026-07-13T00:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "abcdef1234567890",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "waiting_for_reset",
    resetAt: at(90 * 60_000),
    createdAt: at(-1000),
    updatedAt: at(-1000),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("renderSummaryLine", () => {
  it("says 'no jobs' for an empty store", () => {
    expect(renderSummaryLine(summarizeJobs([]), { now: NOW })).toBe("no jobs");
  });

  it("lists only non-zero statuses in lifecycle order with a next-reset clause", () => {
    const jobs = [
      job({ status: "waiting_for_reset", resetAt: at(12 * 60_000) }),
      job({ status: "waiting_for_reset", resetAt: at(30 * 60_000) }),
      job({ status: "completed", resetAt: null }),
    ];
    expect(renderSummaryLine(summarizeJobs(jobs), { now: NOW })).toBe("2 waiting · 1 done · next reset in 12m");
  });

  it("omits the next-reset clause when nothing is waiting", () => {
    const jobs = [job({ status: "completed", resetAt: null }), job({ status: "failed", resetAt: null })];
    expect(renderSummaryLine(summarizeJobs(jobs), { now: NOW })).toBe("1 done · 1 failed");
  });

  it("uses glyphs and a shorter clause with --icons", () => {
    const jobs = [
      job({ status: "waiting_for_reset", resetAt: at(12 * 60_000) }),
      job({ status: "completed", resetAt: null }),
    ];
    expect(renderSummaryLine(summarizeJobs(jobs), { now: NOW, icons: true })).toBe("⏳1 ✔1 · next 12m");
  });

  it("renders 'no jobs' even in icon mode when the store is empty", () => {
    expect(renderSummaryLine(summarizeJobs([]), { now: NOW, icons: true })).toBe("no jobs");
  });

  it("shows 'due now' once a reset time has passed", () => {
    const jobs = [job({ status: "waiting_for_reset", resetAt: at(-60_000) })];
    expect(renderSummaryLine(summarizeJobs(jobs), { now: NOW })).toBe("1 waiting · next reset in due now");
  });
});

describe("nextResetInMs", () => {
  it("is null when nothing waits", () => {
    expect(nextResetInMs(summarizeJobs([job({ status: "completed", resetAt: null })]), NOW)).toBeNull();
  });

  it("returns the ms until the earliest waiting reset", () => {
    const jobs = [
      job({ status: "waiting_for_reset", resetAt: at(30 * 60_000) }),
      job({ status: "waiting_for_reset", resetAt: at(10 * 60_000) }),
    ];
    expect(nextResetInMs(summarizeJobs(jobs), NOW)).toBe(10 * 60_000);
  });

  it("clamps a passed reset to 0 rather than going negative", () => {
    const jobs = [job({ status: "waiting_for_reset", resetAt: at(-5000) })];
    expect(nextResetInMs(summarizeJobs(jobs), NOW)).toBe(0);
  });
});

describe("summaryFieldValue", () => {
  const jobs = [
    job({ status: "queued", resetAt: null }),
    job({ status: "waiting_for_reset", resetAt: at(15 * 60_000) }),
    job({ status: "resuming", resetAt: null }),
    job({ status: "completed", resetAt: null }),
    job({ status: "completed", resetAt: null }),
    job({ status: "failed", resetAt: null }),
    job({ status: "cancelled", resetAt: null }),
  ];
  const summary = summarizeJobs(jobs);

  it("reports per-status counts and the total", () => {
    expect(summaryFieldValue(summary, "total", NOW)).toBe("7");
    expect(summaryFieldValue(summary, "queued", NOW)).toBe("1");
    expect(summaryFieldValue(summary, "waiting", NOW)).toBe("1");
    expect(summaryFieldValue(summary, "resuming", NOW)).toBe("1");
    expect(summaryFieldValue(summary, "completed", NOW)).toBe("2");
    expect(summaryFieldValue(summary, "failed", NOW)).toBe("1");
    expect(summaryFieldValue(summary, "cancelled", NOW)).toBe("1");
  });

  it("counts queued + waiting + resuming as active", () => {
    expect(summaryFieldValue(summary, "active", NOW)).toBe("3");
    expect(ACTIVE_STATUSES).toEqual(["queued", "waiting_for_reset", "resuming"]);
  });

  it("exposes the next reset as ISO, ms, and human countdown", () => {
    expect(summaryFieldValue(summary, "next_reset_at", NOW)).toBe(at(15 * 60_000));
    expect(summaryFieldValue(summary, "next_reset_ms", NOW)).toBe(String(15 * 60_000));
    expect(summaryFieldValue(summary, "next_reset", NOW)).toBe("15m");
  });

  it("emits blanks (and '-') for the next-reset fields when nothing waits", () => {
    const s = summarizeJobs([job({ status: "completed", resetAt: null })]);
    expect(summaryFieldValue(s, "next_reset_at", NOW)).toBe("");
    expect(summaryFieldValue(s, "next_reset_ms", NOW)).toBe("");
    expect(summaryFieldValue(s, "next_reset", NOW)).toBe("-");
  });
});

describe("isSummaryField", () => {
  it("accepts every documented field", () => {
    for (const f of SUMMARY_FIELDS) expect(isSummaryField(f)).toBe(true);
  });

  it("rejects unknown names", () => {
    expect(isSummaryField("bogus")).toBe(false);
    expect(isSummaryField("waiting_for_reset")).toBe(false); // friendly alias is "waiting"
  });
});

describe("renderSummaryJson", () => {
  it("adds derived active/nextResetInMs and echoes storePath when given", () => {
    const jobs = [
      job({ status: "waiting_for_reset", resetAt: at(20 * 60_000) }),
      job({ status: "completed", resetAt: null }),
    ];
    const parsed = JSON.parse(renderSummaryJson(summarizeJobs(jobs), NOW, "/tmp/jobs.json"));
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.total).toBe(2);
    expect(parsed.active).toBe(1);
    expect(parsed.byStatus.completed).toBe(1);
    expect(parsed.nextResetAt).toBe(at(20 * 60_000));
    expect(parsed.nextResetInMs).toBe(20 * 60_000);
  });

  it("omits storePath when not provided and nulls the reset when nothing waits", () => {
    const parsed = JSON.parse(renderSummaryJson(summarizeJobs([job({ status: "failed", resetAt: null })]), NOW));
    expect(parsed).not.toHaveProperty("storePath");
    expect(parsed.nextResetAt).toBeNull();
    expect(parsed.nextResetInMs).toBeNull();
  });
});
