import type { NotifyRequestPreview, TestNotifyResult } from "@agentrelay/core";
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

/** Message shown when `notify preview` runs but no channels are configured. */
export const NO_CHANNELS_PREVIEW_MESSAGE =
  "No notification channels configured — nothing to preview. Set AGENTRELAY_SLACK_WEBHOOK and/or AGENTRELAY_WEBHOOK_URL (see `agentrelay config show`).";

/** Header keys whose value is a secret and must be masked unless revealed. */
const SECRET_HEADERS = new Set(["authorization"]);

/** Pretty-prints a compact wire-body JSON string with 2-space indentation. */
function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // Not JSON (a custom formatBody could produce anything) — show as-is.
    return body;
  }
}

/**
 * Renders the exact HTTP request each configured channel would make, as a
 * human-readable, curl-like block per channel. Pure: no I/O. `color` gates
 * ANSI codes (TTY only); `showSecrets` reveals the otherwise-masked
 * destination URL and `Authorization` header. An empty preview prints the
 * "no channels configured" hint so the command never looks like a silent no-op.
 */
export function renderNotifyPreview(
  previews: NotifyRequestPreview[],
  options: { color?: boolean; showSecrets?: boolean } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  if (previews.length === 0) {
    return NO_CHANNELS_PREVIEW_MESSAGE;
  }

  const lines: string[] = [b("notification preview")];
  previews.forEach((preview, index) => {
    if (index > 0) lines.push("");
    const url = options.showSecrets ? preview.url : maskSecret(preview.url);
    lines.push(`  ${b(preview.channel.label)}  ${d(`(${preview.channel.envVar})`)}`);
    lines.push(`    ${preview.method} ${url}`);
    for (const [key, value] of Object.entries(preview.headers)) {
      const shown = !options.showSecrets && SECRET_HEADERS.has(key.toLowerCase()) ? maskSecret(value) : value;
      lines.push(d(`    ${key}: ${shown}`));
    }
    lines.push("");
    for (const bodyLine of prettyBody(preview.body).split("\n")) {
      lines.push(`    ${bodyLine}`);
    }
  });
  return lines.join("\n");
}

/** Machine-readable form of the previews for `--json`. */
export function renderNotifyPreviewJson(previews: NotifyRequestPreview[]): string {
  return JSON.stringify(
    {
      channels: previews.map((p) => ({
        kind: p.channel.kind,
        label: p.channel.label,
        envVar: p.channel.envVar,
        method: p.method,
        url: p.url,
        headers: p.headers,
        // Parse the wire body so consumers get structured JSON, not a string.
        body: JSON.parse(p.body),
      })),
      configured: previews.length,
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
