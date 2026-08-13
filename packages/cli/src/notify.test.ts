import type { NotifyChannel } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_CHANNELS_LIST_MESSAGE, renderNotifyChannels, renderNotifyChannelsJson } from "./notify.js";

const SLACK: NotifyChannel = {
  kind: "slack",
  label: "Slack",
  url: "https://hooks.slack.com/services/T000/B000/xxxxSECRET1234",
  envVar: "AGENTRELAY_SLACK_WEBHOOK",
};

const WEBHOOK: NotifyChannel = {
  kind: "webhook",
  label: "Webhook",
  url: "https://example.com/relay-hook-abcd",
  envVar: "AGENTRELAY_WEBHOOK_URL",
};

describe("renderNotifyChannels", () => {
  it("shows the setup hint when no channels are configured", () => {
    expect(renderNotifyChannels([])).toBe(NO_CHANNELS_LIST_MESSAGE);
  });

  it("lists each channel with its label and originating env var", () => {
    const out = renderNotifyChannels([SLACK, WEBHOOK]);
    expect(out).toContain("notification channels (2)");
    expect(out).toContain("Slack");
    expect(out).toContain("Webhook");
    expect(out).toContain("[AGENTRELAY_SLACK_WEBHOOK]");
    expect(out).toContain("[AGENTRELAY_WEBHOOK_URL]");
    // Points the user at the delivery command as the next step.
    expect(out).toContain("agentrelay notify test");
  });

  it("masks the destination URL by default, revealing only the last 4 chars", () => {
    const out = renderNotifyChannels([WEBHOOK]);
    expect(out).not.toContain("https://example.com/relay-hook-abcd");
    // maskSecret keeps the final 4 characters visible.
    expect(out).toContain("abcd");
    expect(out).not.toContain("example.com");
  });

  it("reveals the full URL when showSecrets is set", () => {
    const out = renderNotifyChannels([SLACK], { showSecrets: true });
    expect(out).toContain(SLACK.url);
    // The masked middle (a run of dots ending before the last 4 chars) is gone.
    expect(out).not.toContain("••••");
  });

  it("emits no ANSI escape codes when color is off (default)", () => {
    const out = renderNotifyChannels([SLACK]);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the ESC byte is absent.
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("wraps the header and hint in ANSI codes when color is on", () => {
    const out = renderNotifyChannels([SLACK], { color: true });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the ESC byte is present.
    expect(out).toMatch(/\x1b\[/);
  });
});

describe("renderNotifyChannelsJson", () => {
  it("emits an empty channel list and zero count for no channels", () => {
    const parsed = JSON.parse(renderNotifyChannelsJson([]));
    expect(parsed).toEqual({ channels: [], configured: 0 });
  });

  it("emits kind/label/envVar per channel plus a configured count", () => {
    const parsed = JSON.parse(renderNotifyChannelsJson([SLACK, WEBHOOK]));
    expect(parsed.configured).toBe(2);
    expect(parsed.channels).toEqual([
      { kind: "slack", label: "Slack", envVar: "AGENTRELAY_SLACK_WEBHOOK" },
      { kind: "webhook", label: "Webhook", envVar: "AGENTRELAY_WEBHOOK_URL" },
    ]);
  });

  it("never leaks the destination URL in JSON output", () => {
    const json = renderNotifyChannelsJson([SLACK, WEBHOOK]);
    expect(json).not.toContain(SLACK.url);
    expect(json).not.toContain(WEBHOOK.url);
  });
});
