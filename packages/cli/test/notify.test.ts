import type { TestNotifyResult } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { maskChannelUrl, NO_CHANNELS_MESSAGE, renderNotifyTest, renderNotifyTestJson } from "../src/notify.js";

describe("maskChannelUrl", () => {
  it("keeps scheme + host and hides a secret-bearing path", () => {
    expect(maskChannelUrl("https://hooks.slack.com/services/T00/B00/XXXXsecret")).toBe("https://hooks.slack.com/…");
  });

  it("keeps scheme + host and hides a secret-bearing query", () => {
    expect(maskChannelUrl("https://example.test/?token=secret")).toBe("https://example.test/…");
  });

  it("does not add an ellipsis when there is no path or query", () => {
    expect(maskChannelUrl("https://example.test")).toBe("https://example.test");
  });

  it("coarse-masks a non-URL string instead of echoing it", () => {
    expect(maskChannelUrl("not-a-url-but-has-a-secret-token")).toBe("not-a-ur…");
  });
});

function result(overrides: Partial<TestNotifyResult> = {}): TestNotifyResult {
  return { kind: "slack", url: "https://hooks.slack.com/services/abc", ok: true, ...overrides };
}

describe("renderNotifyTest", () => {
  it("returns the no-channels message when nothing was tried", () => {
    expect(renderNotifyTest([])).toBe(NO_CHANNELS_MESSAGE);
  });

  it("masks endpoint URLs by default", () => {
    const out = renderNotifyTest([result()]);
    expect(out).toContain("https://hooks.slack.com/…");
    expect(out).not.toContain("/services/abc");
  });

  it("shows raw URLs with showSecrets", () => {
    const out = renderNotifyTest([result()], { showSecrets: true });
    expect(out).toContain("https://hooks.slack.com/services/abc");
  });

  it("marks delivered and failed channels and echoes the error", () => {
    const out = renderNotifyTest([
      result({ kind: "slack", ok: true }),
      result({ kind: "webhook", ok: false, error: "Webhook responded with HTTP 500" }),
    ]);
    expect(out).toContain("delivered");
    expect(out).toContain("failed");
    expect(out).toContain("HTTP 500");
    expect(out).toContain("1/2 channel(s) delivered");
  });

  it("emits no ANSI codes when color is off", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(renderNotifyTest([result({ ok: false, error: "boom" })])).not.toMatch(/\x1b\[/);
  });
});

describe("renderNotifyTestJson", () => {
  it("echoes counts and per-channel results", () => {
    const json = JSON.parse(
      renderNotifyTestJson(
        [result({ kind: "slack", ok: true }), result({ kind: "webhook", ok: false, error: "x" })],
        "2026-07-19T00:00:00.000Z"
      )
    );
    expect(json.channels).toBe(2);
    expect(json.delivered).toBe(1);
    expect(json.generatedAt).toBe("2026-07-19T00:00:00.000Z");
    expect(json.results).toHaveLength(2);
    expect(json.results[1].error).toBe("x");
  });

  it("reports zero channels for an empty run", () => {
    const json = JSON.parse(renderNotifyTestJson([], "2026-07-19T00:00:00.000Z"));
    expect(json.channels).toBe(0);
    expect(json.delivered).toBe(0);
    expect(json.results).toEqual([]);
  });
});
