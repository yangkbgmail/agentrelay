import type { NotifyRequestPreview, TestNotifyResult } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  NO_CHANNELS_MESSAGE,
  NO_CHANNELS_PREVIEW_MESSAGE,
  renderNotifyPreview,
  renderNotifyPreviewJson,
  renderTestNotifyResults,
  renderTestNotifyResultsJson,
} from "../src/notify.js";

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

function preview(overrides: Partial<NotifyRequestPreview> = {}): NotifyRequestPreview {
  return {
    channel: {
      kind: "webhook",
      label: "Webhook",
      url: "https://hooks.example.test/relay-secret",
      envVar: "AGENTRELAY_WEBHOOK_URL",
    },
    method: "POST",
    url: "https://hooks.example.test/relay-secret",
    headers: { "content-type": "application/json", Authorization: "Bearer super-secret-token" },
    body: JSON.stringify({ jobId: "job-1", event: "completed", text: "hi" }),
    ...overrides,
  };
}

describe("renderNotifyPreview", () => {
  it("shows the no-channels hint for an empty preview set", () => {
    expect(renderNotifyPreview([])).toBe(NO_CHANNELS_PREVIEW_MESSAGE);
  });

  it("masks the URL and Authorization header by default", () => {
    const out = renderNotifyPreview([preview()]);
    expect(out).toContain("POST");
    expect(out).toContain("•");
    expect(out).not.toContain("hooks.example.test");
    expect(out).not.toContain("super-secret-token");
    // content-type is not a secret, so it stays visible.
    expect(out).toContain("content-type: application/json");
    // Body is pretty-printed.
    expect(out).toContain('"event": "completed"');
  });

  it("reveals URL and Authorization when showSecrets is set", () => {
    const out = renderNotifyPreview([preview()], { showSecrets: true });
    expect(out).toContain("https://hooks.example.test/relay-secret");
    expect(out).toContain("Bearer super-secret-token");
  });

  it("emits ANSI codes only when color is enabled", () => {
    expect(renderNotifyPreview([preview()], { color: true })).toContain("\x1b[");
    expect(renderNotifyPreview([preview()], { color: false })).not.toContain("\x1b[");
  });

  it("separates multiple channels", () => {
    const out = renderNotifyPreview([
      preview({
        channel: {
          kind: "slack",
          label: "Slack",
          url: "https://hooks.slack.test/abc",
          envVar: "AGENTRELAY_SLACK_WEBHOOK",
        },
        url: "https://hooks.slack.test/abc",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "slack" }),
      }),
      preview(),
    ]);
    expect(out).toContain("Slack");
    expect(out).toContain("Webhook");
    expect(out).toContain("AGENTRELAY_SLACK_WEBHOOK");
  });
});

describe("renderNotifyPreviewJson", () => {
  it("reports configured=0 for an empty set", () => {
    const json = JSON.parse(renderNotifyPreviewJson([]));
    expect(json).toEqual({ channels: [], configured: 0 });
  });

  it("emits structured (parsed) bodies and the real headers/url", () => {
    const json = JSON.parse(renderNotifyPreviewJson([preview()]));
    expect(json.configured).toBe(1);
    expect(json.channels[0].method).toBe("POST");
    expect(json.channels[0].url).toBe("https://hooks.example.test/relay-secret");
    expect(json.channels[0].headers.Authorization).toBe("Bearer super-secret-token");
    // body is parsed JSON, not a string.
    expect(json.channels[0].body).toEqual({ jobId: "job-1", event: "completed", text: "hi" });
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
