import type { AgentTool, JobStatus, RelayJob, TestNotifyResult } from "@agentrelay/core";
import { computeStats } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  buildDigestMessage,
  buildDigestPayload,
  NO_CHANNELS_MESSAGE,
  renderTestNotifyResults,
  renderTestNotifyResultsJson,
} from "../src/notify.js";

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

function result(overrides: Partial<TestNotifyResult> = {}): TestNotifyResult {
  return {
    channel: {
      kind: "webhook",
      label: "Webhook",
      url: "https://hooks.example.test/relay-secret",
      envVar: "AGENTRELAY_WEBHOOK_URL",
    },
    ok: true,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-13T00:00:00.000Z");

describe("buildDigestMessage", () => {
  it("returns a single onboarding line for an empty store", () => {
    expect(buildDigestMessage(computeStats([]), NOW)).toBe(
      "No jobs tracked yet. Run `agentrelay run -- <your agent command>` to get started."
    );
  });

  it("summarizes waiting/active/finished counts and the next reset countdown", () => {
    const stats = computeStats([
      job({ status: "waiting_for_reset", resetAt: "2026-07-13T01:30:00.000Z" }),
      job({ status: "queued" }),
      job({ status: "resuming" }),
      job({ status: "completed" }),
      job({ status: "failed" }),
    ]);
    const msg = buildDigestMessage(stats, NOW);
    expect(msg).toContain("5 job(s) tracked — 1 waiting, 2 active, 2 finished.");
    expect(msg).toContain("Next reset in 1h 30m.");
    expect(msg).toContain("Success rate 50%");
  });

  it("omits the next-reset line when nothing is waiting for reset", () => {
    const stats = computeStats([job({ status: "completed" }), job({ status: "failed" })]);
    const msg = buildDigestMessage(stats, NOW);
    expect(msg).not.toContain("Next reset");
    expect(msg).toContain("Success rate 50%");
  });

  it("notes retried jobs and total attempts when any job was retried", () => {
    const stats = computeStats([job({ status: "completed", attempts: 3 }), job({ status: "completed", attempts: 1 })]);
    const msg = buildDigestMessage(stats, NOW);
    expect(msg).toContain("2 job(s) tracked");
    expect(msg).toContain("1 job(s) retried across 4 attempt(s).");
    expect(msg).toContain("Success rate 100%");
  });

  it("shows n/a success rate when nothing has resolved", () => {
    const stats = computeStats([job({ status: "waiting_for_reset", resetAt: "2026-07-13T02:00:00.000Z" })]);
    expect(buildDigestMessage(stats, NOW)).toContain("Success rate n/a.");
  });
});

describe("buildDigestPayload", () => {
  it("wraps the message in a digest-event payload with defaults", () => {
    const payload = buildDigestPayload(computeStats([job({ status: "completed" })]), { now: NOW });
    expect(payload.event).toBe("digest");
    expect(payload.jobId).toBe("queue-digest");
    expect(payload.project).toBe("agentrelay");
    expect(payload.message).toContain("1 job(s) tracked");
  });

  it("honors a project override", () => {
    const payload = buildDigestPayload(computeStats([]), { now: NOW, project: "my-app" });
    expect(payload.project).toBe("my-app");
  });
});

describe("renderTestNotifyResults", () => {
  it("shows the no-channels hint for an empty result set", () => {
    expect(renderTestNotifyResults([])).toBe(NO_CHANNELS_MESSAGE);
  });

  it("masks destination URLs by default, keeping the last 4 chars", () => {
    const out = renderTestNotifyResults([result()]);
    expect(out).toContain("•");
    expect(out).toContain("cret"); // last 4 of "...relay-secret"
    expect(out).not.toContain("hooks.example.test");
    expect(out).toContain("delivered");
    expect(out).toContain("all 1 channel(s) delivered");
  });

  it("reveals full URLs when showSecrets is set", () => {
    const out = renderTestNotifyResults([result()], { showSecrets: true });
    expect(out).toContain("https://hooks.example.test/relay-secret");
    expect(out).not.toContain("•");
  });

  it("renders failures with their error and a failure summary", () => {
    const out = renderTestNotifyResults([
      result({ ok: false, error: "Webhook responded with HTTP 503" }),
      result({
        channel: {
          kind: "slack",
          label: "Slack",
          url: "https://hooks.slack.test/abc",
          envVar: "AGENTRELAY_SLACK_WEBHOOK",
        },
        ok: true,
      }),
    ]);
    expect(out).toContain("FAILED");
    expect(out).toContain("Webhook responded with HTTP 503");
    expect(out).toContain("1 of 2 channel(s) failed");
  });

  it("emits ANSI codes only when color is enabled", () => {
    expect(renderTestNotifyResults([result()], { color: true })).toContain("\x1b[");
    expect(renderTestNotifyResults([result()], { color: false })).not.toContain("\x1b[");
  });

  it("uses the default header, or a custom title when given", () => {
    expect(renderTestNotifyResults([result()])).toContain("notification test");
    expect(renderTestNotifyResults([result()], { title: "digest delivery" })).toContain("digest delivery");
    expect(renderTestNotifyResults([result()], { title: "digest delivery" })).not.toContain("notification test");
  });
});

describe("renderTestNotifyResultsJson", () => {
  it("reports ok=false and configured=0 for an empty set", () => {
    const json = JSON.parse(renderTestNotifyResultsJson([]));
    expect(json).toEqual({ channels: [], ok: false, configured: 0, failed: 0 });
  });

  it("summarizes per-channel results with null errors on success", () => {
    const json = JSON.parse(
      renderTestNotifyResultsJson([
        result({ ok: false, error: "HTTP 500" }),
        result({
          channel: {
            kind: "slack",
            label: "Slack",
            url: "https://hooks.slack.test/abc",
            envVar: "AGENTRELAY_SLACK_WEBHOOK",
          },
          ok: true,
        }),
      ])
    );
    expect(json.ok).toBe(false);
    expect(json.configured).toBe(2);
    expect(json.failed).toBe(1);
    expect(json.channels[0]).toEqual({
      kind: "webhook",
      label: "Webhook",
      envVar: "AGENTRELAY_WEBHOOK_URL",
      ok: false,
      error: "HTTP 500",
    });
    expect(json.channels[1].error).toBeNull();
  });

  it("does not leak secret URLs into JSON output", () => {
    const json = renderTestNotifyResultsJson([result()]);
    expect(json).not.toContain("relay-secret");
  });
});
