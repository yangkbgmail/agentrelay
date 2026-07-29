import type { NotifyChannel, TestNotifyResult } from "@agentrelay/core";
import { maskSecret } from "./config.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Message shown when `notify test` runs but no channels are configured. */
export const NO_CHANNELS_MESSAGE =
  "No notification channels configured. Set AGENTRELAY_SLACK_WEBHOOK and/or AGENTRELAY_WEBHOOK_URL (see `agentrelay config show`).";

/**
 * Renders the per-channel test-delivery results as a human-readable checklist.
 * Pure: no I/O. `color` gates ANSI codes (TTY only); `showSecrets` reveals the
 * otherwise-masked destination URLs. An empty result set prints the
 * "no channels configured" hint so the command never looks like a silent no-op.
 */
export function renderTestNotifyResults(
  results: TestNotifyResult[],
  options: { color?: boolean; showSecrets?: boolean } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);
  const ok = (s: string) => (color ? `${GREEN}${s}${RESET}` : s);
  const bad = (s: string) => (color ? `${RED}${s}${RESET}` : s);

  if (results.length === 0) {
    return NO_CHANNELS_MESSAGE;
  }

  const lines: string[] = [b("notification test")];
  for (const result of results) {
    const url = options.showSecrets ? result.channel.url : maskSecret(result.channel.url);
    const mark = result.ok ? ok("✓") : bad("✗");
    const status = result.ok ? ok("delivered") : bad("FAILED");
    lines.push(`  ${mark} ${result.channel.label.padEnd(8)} ${status}  ${d(url)}`);
    if (!result.ok && result.error) {
      lines.push(`      ${d(result.error)}`);
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  lines.push("");
  lines.push(
    failed === 0
      ? ok(`all ${results.length} channel(s) delivered`)
      : bad(`${failed} of ${results.length} channel(s) failed`)
  );
  return lines.join("\n");
}

/**
 * A resolved view of the notification channels the relay loop will actually
 * use, plus whether an `Authorization` header will accompany the generic
 * webhook. This is what `agentrelay notify channels` reports — the read-only
 * companion of `notify test` (which actually delivers) and the resolved sibling
 * of `config show` (which lists raw env/config values, blank ones included).
 */
export interface NotifyChannelsView {
  channels: NotifyChannel[];
  /**
   * True when AGENTRELAY_WEBHOOK_AUTH is set, so the generic webhook POST will
   * carry an `Authorization` header. Only meaningful when a webhook channel is
   * present; it is ignored for Slack (which has no auth header).
   */
  webhookAuthConfigured: boolean;
}

/**
 * Renders the configured notification channels as a human-readable list — no
 * network call, so it is safe to run before an event ever fires. Destination
 * URLs are masked by default (`showSecrets` reveals them). For the webhook
 * channel, an "auth ✓" hint shows whether an Authorization header will be sent.
 * An empty channel set prints the "no channels configured" hint so the command
 * never looks like a silent no-op. Pure: no I/O; `color` gates ANSI codes.
 */
export function renderNotifyChannels(
  view: NotifyChannelsView,
  options: { color?: boolean; showSecrets?: boolean } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);
  const ok = (s: string) => (color ? `${GREEN}${s}${RESET}` : s);

  if (view.channels.length === 0) {
    return NO_CHANNELS_MESSAGE;
  }

  const lines: string[] = [b("notification channels")];
  for (const channel of view.channels) {
    const url = options.showSecrets ? channel.url : maskSecret(channel.url);
    let line = `  ${ok("✓")} ${channel.label.padEnd(8)} ${d(url)}  ${d(`[${channel.envVar}]`)}`;
    if (channel.kind === "webhook") {
      line += `  ${d(view.webhookAuthConfigured ? "auth ✓" : "no auth")}`;
    }
    lines.push(line);
  }

  lines.push("");
  lines.push(d(`${view.channels.length} channel(s) configured — run \`agentrelay notify test\` to verify delivery`));
  return lines.join("\n");
}

/**
 * Machine-readable form of the configured channels for `--json`. Destination
 * URLs are always emitted masked (never in full, regardless of flags) so a
 * secret can't leak into a script's captured output.
 */
export function renderNotifyChannelsJson(view: NotifyChannelsView): string {
  return JSON.stringify(
    {
      channels: view.channels.map((channel) => ({
        kind: channel.kind,
        label: channel.label,
        envVar: channel.envVar,
        url: maskSecret(channel.url),
        ...(channel.kind === "webhook" ? { authConfigured: view.webhookAuthConfigured } : {}),
      })),
      configured: view.channels.length,
    },
    null,
    2
  );
}

/** Machine-readable form of the test results for `--json`. */
export function renderTestNotifyResultsJson(results: TestNotifyResult[]): string {
  return JSON.stringify(
    {
      channels: results.map((r) => ({
        kind: r.channel.kind,
        label: r.channel.label,
        envVar: r.channel.envVar,
        ok: r.ok,
        error: r.error ?? null,
      })),
      ok: results.length > 0 && results.every((r) => r.ok),
      configured: results.length,
      failed: results.filter((r) => !r.ok).length,
    },
    null,
    2
  );
}
