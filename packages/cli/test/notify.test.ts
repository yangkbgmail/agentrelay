import type { TestNotifyResult } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_CHANNELS_MESSAGE, renderTestNotifyResults, renderTestNotifyResultsJson } from "../src/notify.js";

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
