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

/** Message shown when `notify list` finds no channels configured. */
export const NO_CHANNELS_LIST_MESSAGE =
  "No notification channels configured. Set AGENTRELAY_SLACK_WEBHOOK and/or AGENTRELAY_WEBHOOK_URL to get queue-event notifications (see `agentrelay config show`).";

/**
 * Renders the configured notification channels as a static inventory — the
 * read-only counterpart to {@link renderTestNotifyResults}, which actually
 * delivers a payload. Answers "which channels are wired up?" without touching
 * the network, so it's safe to run when the endpoints are down. Pure: no I/O.
 * `color` gates ANSI codes (TTY only); `showSecrets` reveals the otherwise-
 * masked destination URLs. An empty channel list prints the setup hint so the
 * command never looks like a silent no-op.
 */
export function renderNotifyChannels(
  channels: NotifyChannel[],
  options: { color?: boolean; showSecrets?: boolean } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  if (channels.length === 0) {
    return NO_CHANNELS_LIST_MESSAGE;
  }

  const lines: string[] = [b(`notification channels (${channels.length})`)];
  for (const channel of channels) {
    const url = options.showSecrets ? channel.url : maskSecret(channel.url);
    lines.push(`  • ${channel.label.padEnd(8)} ${d(url)}  ${d(`[${channel.envVar}]`)}`);
  }
  lines.push("");
  lines.push(d("Run `agentrelay notify test` to send a live test payload to each channel."));
  return lines.join("\n");
}

/**
 * Machine-readable form of the channel inventory for `--json`. Deliberately
 * omits the destination URL — a secret — so a `--json` dump is safe to log or
 * paste, matching how {@link renderTestNotifyResultsJson} never echoes the URL.
 */
export function renderNotifyChannelsJson(channels: NotifyChannel[]): string {
  return JSON.stringify(
    {
      channels: channels.map((c) => ({ kind: c.kind, label: c.label, envVar: c.envVar })),
      configured: channels.length,
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
