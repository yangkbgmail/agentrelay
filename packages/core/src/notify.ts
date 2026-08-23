import { spawn } from "node:child_process";
import type { Notifier } from "./scheduler.js";
import type { NotifyPayload } from "./types.js";

const EVENT_EMOJI: Record<NotifyPayload["event"], string> = {
  queued: "⏳",
  resumed: "▶️",
  completed: "✅",
  failed: "❌",
};

export function formatSlackText(payload: NotifyPayload): string {
  return `${EVENT_EMOJI[payload.event]} *AgentRelay — ${payload.project}* (${payload.event})\n${payload.message}\n_job ${payload.jobId}_`;
}

export interface SlackNotifierOptions {
  webhookUrl: string;
  /** Injected for tests; defaults to global fetch (Node >= 18). */
  fetchFn?: typeof fetch;
  /** Called when the webhook request fails. Defaults to a stderr warning. */
  onError?: (error: unknown) => void;
}

/**
 * Returns a Notifier that posts each queue event to a Slack incoming
 * webhook. Delivery failures are reported through `onError` but never
 * thrown -- a broken webhook must not take down the relay loop.
 */
export function createSlackNotifier(options: SlackNotifierOptions): Notifier {
  const fetchFn = options.fetchFn ?? fetch;
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error(`[agentrelay] Slack notification failed: ${String(error)}`);
    });

  return async (payload: NotifyPayload) => {
    try {
      const response = await fetchFn(options.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: formatSlackText(payload) }),
      });
      if (!response.ok) {
        onError(new Error(`Slack webhook responded with HTTP ${response.status}`));
      }
    } catch (error) {
      onError(error);
    }
  };
}

/**
 * Builds a Slack notifier from `AGENTRELAY_SLACK_WEBHOOK`. Returns null when
 * the variable is unset/empty so callers can silently skip Slack delivery.
 */
export function slackNotifierFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: Omit<SlackNotifierOptions, "webhookUrl"> = {}
): Notifier | null {
  const webhookUrl = env.AGENTRELAY_SLACK_WEBHOOK?.trim();
  if (!webhookUrl) return null;
  return createSlackNotifier({ webhookUrl, ...options });
}

/** Fans one notification out to several notifiers, awaiting them all. */
export function combineNotifiers(...notifiers: Array<Notifier | null | undefined>): Notifier {
  const active = notifiers.filter((n): n is Notifier => typeof n === "function");
  return async (payload: NotifyPayload) => {
    await Promise.all(active.map((notify) => notify(payload)));
  };
}

export interface WebhookNotifierOptions {
  /** Endpoint that receives a POST for every queue event. */
  url: string;
  /**
   * Extra headers merged onto `{ "content-type": "application/json" }`.
   * Use this to pass an `Authorization` token or a signing header.
   */
  headers?: Record<string, string>;
  /**
   * Shapes the JSON body for a payload. Defaults to sending the raw
   * `NotifyPayload` plus a human-readable `text` field, which suits generic
   * receivers. Override it to match a specific service's schema, e.g.
   * `(p) => ({ content: formatSlackText(p) })` for Discord.
   */
  formatBody?: (payload: NotifyPayload) => unknown;
  /** Injected for tests; defaults to global fetch (Node >= 18). */
  fetchFn?: typeof fetch;
  /** Called when the webhook request fails. Defaults to a stderr warning. */
  onError?: (error: unknown) => void;
}

/**
 * Returns a Notifier that POSTs each queue event to an arbitrary HTTP
 * endpoint as JSON. Unlike the Slack notifier (which emits Slack's
 * `{ text }` shape), this sends the structured `NotifyPayload` so any
 * service -- Discord, n8n, a home-automation hook, a custom server -- can
 * consume it. Delivery failures are reported through `onError` but never
 * thrown, so a broken webhook can't take down the relay loop.
 */
export function createWebhookNotifier(options: WebhookNotifierOptions): Notifier {
  const fetchFn = options.fetchFn ?? fetch;
  const formatBody =
    options.formatBody ?? ((payload: NotifyPayload) => ({ ...payload, text: formatSlackText(payload) }));
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error(`[agentrelay] Webhook notification failed: ${String(error)}`);
    });

  return async (payload: NotifyPayload) => {
    try {
      const response = await fetchFn(options.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...options.headers },
        body: JSON.stringify(formatBody(payload)),
      });
      if (!response.ok) {
        onError(new Error(`Webhook responded with HTTP ${response.status}`));
      }
    } catch (error) {
      onError(error);
    }
  };
}

/**
 * Builds a generic webhook notifier from `AGENTRELAY_WEBHOOK_URL`. When
 * `AGENTRELAY_WEBHOOK_AUTH` is set, its value is sent as the `Authorization`
 * header. Returns null when the URL is unset/blank so callers can silently
 * skip webhook delivery.
 */
export function webhookNotifierFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: Omit<WebhookNotifierOptions, "url"> = {}
): Notifier | null {
  const url = env.AGENTRELAY_WEBHOOK_URL?.trim();
  if (!url) return null;
  const auth = env.AGENTRELAY_WEBHOOK_AUTH?.trim();
  const headers = auth ? { Authorization: auth, ...options.headers } : options.headers;
  return createWebhookNotifier({ url, ...options, headers });
}

/** How the desktop-notification command is launched; injected in tests. */
export type DesktopSpawnFn = (command: string, args: string[]) => void;

/** The values `AGENTRELAY_DESKTOP_NOTIFY` accepts as "on" (case-insensitive). */
const DESKTOP_TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Builds the OS command that raises a native desktop notification for `payload`,
 * or `null` when `platform` has no built-in notifier we support. Pure and
 * shell-free: every dynamic value is passed as a separate argv entry (Linux) or
 * escaped into the interpreter's own string-literal syntax (macOS AppleScript,
 * Windows PowerShell), so a project name or message can never break out into a
 * command. This is the single place platform-specific behaviour lives, so it can
 * be unit-tested without spawning anything.
 *
 * - **macOS** (`darwin`): `osascript -e 'display notification …'`.
 * - **Linux**: `notify-send` (libnotify — present on most desktops).
 * - **Windows** (`win32`): a PowerShell balloon tip via the built-in
 *   `System.Windows.Forms.NotifyIcon` (.NET ships with Windows). Best-effort.
 */
export function buildDesktopCommand(
  platform: NodeJS.Platform,
  payload: NotifyPayload
): { command: string; args: string[] } | null {
  const title = `AgentRelay — ${payload.project}`;
  const body = `${EVENT_EMOJI[payload.event]} ${payload.event}: ${payload.message}`;
  switch (platform) {
    case "darwin": {
      // AppleScript double-quoted string: escape backslashes first, then quotes.
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const script = `display notification "${esc(body)}" with title "${esc(title)}"`;
      return { command: "osascript", args: ["-e", script] };
    }
    case "linux":
      // Title and body are separate argv entries — no shell, so no escaping.
      return { command: "notify-send", args: ["--app-name=AgentRelay", title, body] };
    case "win32": {
      // PowerShell single-quoted literal: a literal quote is written by doubling it.
      const esc = (s: string) => s.replace(/'/g, "''");
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "Add-Type -AssemblyName System.Drawing;",
        "$n = New-Object System.Windows.Forms.NotifyIcon;",
        "$n.Icon = [System.Drawing.SystemIcons]::Information;",
        `$n.BalloonTipTitle = '${esc(title)}';`,
        `$n.BalloonTipText = '${esc(body)}';`,
        "$n.Visible = $true;",
        "$n.ShowBalloonTip(10000);",
        "Start-Sleep -Seconds 10;",
        "$n.Dispose();",
      ].join(" ");
      return { command: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
    }
    default:
      return null;
  }
}

export interface DesktopNotifierOptions {
  /** OS to build the command for. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /**
   * How to launch the command; injected in tests. Defaults to spawning it
   * detached with all stdio ignored, routing spawn errors (e.g. the binary
   * isn't installed) to `onError` rather than crashing the relay loop.
   */
  spawnFn?: DesktopSpawnFn;
  /** Called when the notification can't be raised. Defaults to a stderr warning. */
  onError?: (error: unknown) => void;
}

/** The default spawner: fire-and-forget, never throws, errors go to `onError`. */
function defaultDesktopSpawn(onError: (error: unknown) => void): DesktopSpawnFn {
  return (command, args) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", onError);
    child.unref();
  };
}

/**
 * Returns a Notifier that raises a native OS desktop notification for each queue
 * event — the most useful channel for a local-first tool, since the person
 * waiting on a rate-limit reset is usually right at the machine. Unsupported
 * platforms and spawn failures are reported through `onError` but never thrown,
 * so a missing `notify-send` (or a headless box) can't take down the relay loop.
 */
export function createDesktopNotifier(options: DesktopNotifierOptions = {}): Notifier {
  const platform = options.platform ?? process.platform;
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error(`[agentrelay] Desktop notification failed: ${String(error)}`);
    });
  const spawnFn = options.spawnFn ?? defaultDesktopSpawn(onError);

  return async (payload: NotifyPayload) => {
    const cmd = buildDesktopCommand(platform, payload);
    if (!cmd) {
      onError(new Error(`Desktop notifications are not supported on platform "${platform}"`));
      return;
    }
    try {
      spawnFn(cmd.command, cmd.args);
    } catch (error) {
      onError(error);
    }
  };
}

/** True when `AGENTRELAY_DESKTOP_NOTIFY` is set to a recognised "on" value. */
export function isDesktopNotifyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.AGENTRELAY_DESKTOP_NOTIFY?.trim().toLowerCase();
  return value !== undefined && DESKTOP_TRUTHY.has(value);
}

/**
 * Builds a desktop notifier when `AGENTRELAY_DESKTOP_NOTIFY` is enabled, else
 * null so callers can silently skip it. Opt-in because it only makes sense on a
 * machine with a desktop session (never a CI runner or a remote daemon).
 */
export function desktopNotifierFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: Omit<DesktopNotifierOptions, "platform"> = {}
): Notifier | null {
  if (!isDesktopNotifyEnabled(env)) return null;
  return createDesktopNotifier(options);
}

/**
 * Assembles the notifier configured through the environment: Slack
 * (`AGENTRELAY_SLACK_WEBHOOK`), a generic webhook (`AGENTRELAY_WEBHOOK_URL`),
 * and/or a native desktop notification (`AGENTRELAY_DESKTOP_NOTIFY`), fanned out
 * together. Returns null when none is configured, so callers can report
 * "notifications off" and skip work.
 */
export function notifiersFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: { fetchFn?: typeof fetch; spawnFn?: DesktopSpawnFn; onError?: (error: unknown) => void } = {}
): Notifier | null {
  const configured = [
    slackNotifierFromEnv(env, options),
    webhookNotifierFromEnv(env, options),
    desktopNotifierFromEnv(env, { spawnFn: options.spawnFn, onError: options.onError }),
  ].filter((n): n is Notifier => typeof n === "function");
  if (configured.length === 0) return null;
  return combineNotifiers(...configured);
}

export type NotifyChannelKind = "slack" | "webhook" | "desktop";

/** A notification channel configured through the environment. */
export interface NotifyChannel {
  kind: NotifyChannelKind;
  /** Human-readable label ("Slack" / "Webhook" / "Desktop"). */
  label: string;
  /**
   * Destination descriptor. For URL-based channels this is the endpoint (treat
   * as a secret when displaying); for the desktop channel it's the OS command
   * that would be run (e.g. `notify-send`), which is not sensitive.
   */
  url: string;
  /** The environment variable the channel was read from. */
  envVar: string;
  /**
   * Whether {@link url} should be masked when echoed to a user. Absent (the
   * default) means "mask it" — set to `false` only for non-secret descriptors
   * like the desktop command name.
   */
  secret?: boolean;
}

/**
 * Enumerates the notify channels configured through the environment, in a
 * stable order (Slack first, then the generic webhook). Blank/whitespace-only
 * values are skipped so an empty env var doesn't masquerade as a channel.
 * This is the single source of truth for "which channels are configured";
 * {@link sendTestNotification} builds on it.
 */
export function listNotifyChannels(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform
): NotifyChannel[] {
  const channels: NotifyChannel[] = [];
  const slack = env.AGENTRELAY_SLACK_WEBHOOK?.trim();
  if (slack) {
    channels.push({ kind: "slack", label: "Slack", url: slack, envVar: "AGENTRELAY_SLACK_WEBHOOK" });
  }
  const webhook = env.AGENTRELAY_WEBHOOK_URL?.trim();
  if (webhook) {
    channels.push({ kind: "webhook", label: "Webhook", url: webhook, envVar: "AGENTRELAY_WEBHOOK_URL" });
  }
  if (isDesktopNotifyEnabled(env)) {
    const cmd = buildDesktopCommand(platform, testNotifyPayload());
    channels.push({
      kind: "desktop",
      label: "Desktop",
      url: cmd ? cmd.command : `unsupported on ${platform}`,
      envVar: "AGENTRELAY_DESKTOP_NOTIFY",
      secret: false,
    });
  }
  return channels;
}

/**
 * The synthetic payload sent by `agentrelay notify test`. It uses the same
 * shape a real event does, so it exercises the exact formatting/body path a
 * production notification would take.
 */
export function testNotifyPayload(): NotifyPayload {
  return {
    jobId: "test-notification",
    project: "agentrelay",
    event: "completed",
    message: "Test notification from `agentrelay notify test` — if you can read this, delivery works.",
  };
}

/** The outcome of delivering the test payload to a single channel. */
export interface TestNotifyResult {
  channel: NotifyChannel;
  /** True when the endpoint accepted the delivery (HTTP 2xx, no throw). */
  ok: boolean;
  /** Present when `ok` is false: the failure reason (HTTP status or thrown error). */
  error?: string;
}

export interface SendTestNotificationOptions {
  env?: Record<string, string | undefined>;
  /** Injected for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Injected for tests; how the desktop notifier launches its command. */
  spawnFn?: DesktopSpawnFn;
  /** OS to build the desktop command for. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Overrides the synthetic payload (defaults to {@link testNotifyPayload}). */
  payload?: NotifyPayload;
}

/**
 * Delivers the test payload to every configured channel independently and
 * reports a per-channel result. Reuses the production notifier factories, so a
 * pass here means the *real* delivery path (body shape, auth header, HTTP
 * status handling) works — not merely that a URL is set. Each channel is
 * awaited; a failure on one never throws or aborts the others. Returns an
 * empty array when no channels are configured.
 */
export async function sendTestNotification(options: SendTestNotificationOptions = {}): Promise<TestNotifyResult[]> {
  const env = options.env ?? process.env;
  const payload = options.payload ?? testNotifyPayload();
  const platform = options.platform ?? process.platform;
  const channels = listNotifyChannels(env, platform);
  return Promise.all(
    channels.map(async (channel): Promise<TestNotifyResult> => {
      let captured: unknown;
      const onError = (error: unknown) => {
        captured = error;
      };
      let notifier: Notifier;
      if (channel.kind === "slack") {
        notifier = createSlackNotifier({ webhookUrl: channel.url, fetchFn: options.fetchFn, onError });
      } else if (channel.kind === "desktop") {
        notifier = createDesktopNotifier({ platform, spawnFn: options.spawnFn, onError });
      } else {
        notifier = createWebhookNotifier({
          url: channel.url,
          headers: webhookAuthHeader(env),
          fetchFn: options.fetchFn,
          onError,
        });
      }
      await notifier(payload);
      if (captured === undefined) return { channel, ok: true };
      const message = captured instanceof Error ? captured.message : String(captured);
      return { channel, ok: false, error: message };
    })
  );
}

/** Builds the `Authorization` header for the generic webhook, if configured. */
function webhookAuthHeader(env: Record<string, string | undefined>): Record<string, string> | undefined {
  const auth = env.AGENTRELAY_WEBHOOK_AUTH?.trim();
  return auth ? { Authorization: auth } : undefined;
}
