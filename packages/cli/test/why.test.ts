import type { JobExplanation } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { renderExplanation, renderExplanationJson } from "../src/why.js";

function explanation(overrides: Partial<JobExplanation> = {}): JobExplanation {
  return {
    id: "abcdef1234567890",
    status: "waiting_for_reset",
    disposition: "waiting",
    headline: "Waiting for rate-limit reset — resumes at 2026-07-30T17:30:00.000Z.",
    reasons: ['Rate limit detected via pattern `clock-time` from: "resets at 5:30pm"', "Attempt 2 of 5."],
    nextAction: "Nothing to do; it resumes automatically.",
    resumesInMs: 90 * 60_000,
    attempt: 2,
    maxAttempts: 5,
    retryExhausted: false,
    ...overrides,
  };
}

describe("renderExplanation", () => {
  it("renders headline, disposition tag, reasons, and next action", () => {
    const out = renderExplanation(explanation());
    expect(out).toContain("Job abcdef1234567890 [waiting]");
    expect(out).toContain("Waiting for rate-limit reset");
    expect(out).toContain("• Attempt 2 of 5.");
    expect(out).toContain("→ Nothing to do");
  });

  it("shows a countdown when resumesInMs is positive", () => {
    const out = renderExplanation(explanation({ resumesInMs: 90 * 60_000 }));
    expect(out).toMatch(/resumes in .*1h/);
  });

  it("shows 'due now' when resumesInMs is 0", () => {
    const out = renderExplanation(explanation({ disposition: "due", resumesInMs: 0 }));
    expect(out).toContain("resumes due now");
  });

  it("omits the resumes line when resumesInMs is null", () => {
    const out = renderExplanation(
      explanation({
        disposition: "completed",
        headline: "Completed successfully.",
        nextAction: "Nothing to do.",
        resumesInMs: null,
      })
    );
    expect(out).not.toContain("resumes");
  });

  it("emits ANSI color only when color:true", () => {
    expect(renderExplanation(explanation(), { color: false })).not.toContain("\x1b[");
    expect(renderExplanation(explanation(), { color: true })).toContain("\x1b[");
  });

  it("renderExplanationJson wraps the explanation with store metadata", () => {
    const json = JSON.parse(renderExplanationJson(explanation(), "/tmp/jobs.json", "2026-07-30T12:00:00.000Z"));
    expect(json.storePath).toBe("/tmp/jobs.json");
    expect(json.generatedAt).toBe("2026-07-30T12:00:00.000Z");
    expect(json.explanation.disposition).toBe("waiting");
  });
});
