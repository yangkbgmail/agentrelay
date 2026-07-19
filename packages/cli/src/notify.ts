// Rendering helpers for `agentrelay notify test` — the command that actually
// POSTs a sample payload to each configured channel (Slack / webhook) and
// reports whether delivery worked. `doctor` only checks that a channel is
// *configured*; this proves it *delivers*. Pure functions here (separate from
// the commander wiring in cli.ts) so the output is unit-testable without a
// network, a TTY, or real env vars.

import type { TestNotifyResult } from "@agentrelay/core";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const CHANNEL_LABEL: Record<TestNotifyResult["kind"], string> = {
  slack: "Slack",
  webhook: "webhook",
};

export const NO_CHANNELS_MESSAGE =
  "No notification channels configured. Set AGENTRELAY_SLACK_WEBHOOK and/or AGENTRELAY_WEBHOOK_URL, then try again.";

/**
 * Masks the secret-bearing parts of a channel URL for display. Slack webhooks
 * (and often generic ones) embed a token in the path/query, so we keep only
 * the scheme + host and replace the rest with `/…`. Unparseable strings fall
 * back to a coarse prefix mask so a secret is never echoed in full.
 */
export function maskChannelUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const hasSecretTail = (parsed.pathname && parsed.pathname !== "/") || parsed.search;
    return `${parsed.protocol}//${parsed.host}${hasSecretTail ? "/…" : ""}`;
  } catch {
    // Not a valid URL — show at most the first few chars so a token can't leak.
    return url.length <= 8 ? url : `${url.slice(0, 8)}…`;
  }
}

export interface RenderNotifyTestOptions {
  /** Emit ANSI color codes (only makes sense on a TTY). */
  color?: boolean;
  /** Show raw endpoint URLs instead of masking their secret parts. */
  showSecrets?: boolean;
}

/** Human-readable report of a `notify test` run. */
export function renderNotifyTest(results: TestNotifyResult[], options: RenderNotifyTestOptions = {}): string {
  const color = options.color ?? false;
  const showSecrets = options.showSecrets ?? false;
  if (results.length === 0) return NO_CHANNELS_MESSAGE;

  const paint = (code: string, text: string) => (color ? `${code}${text}${RESET}` : text);
  const lines: string[] = [];
  for (const result of results) {
    const label = CHANNEL_LABEL[result.kind];
    const endpoint = showSecrets ? result.url : maskChannelUrl(result.url);
    const mark = result.ok ? paint(GREEN, "✓ delivered") : paint(RED, "✗ failed");
    let line = `${paint(BOLD, label)}  ${mark}  ${paint(DIM, endpoint)}`;
    if (!result.ok && result.error) line += `\n  ${paint(DIM, result.error)}`;
    lines.push(line);
  }

  const delivered = results.filter((r) => r.ok).length;
  const summary = `${delivered}/${results.length} channel(s) delivered`;
  lines.push(paint(DIM, summary));
  return lines.join("\n");
}

/** Machine-readable (`--json`) report for scripts / jq. */
export function renderNotifyTestJson(results: TestNotifyResult[], generatedAt: string): string {
  const delivered = results.filter((r) => r.ok).length;
  return JSON.stringify(
    {
      generatedAt,
      channels: results.length,
      delivered,
      results,
    },
    null,
    2
  );
}
