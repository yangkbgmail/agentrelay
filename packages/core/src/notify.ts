import { type ChildProcess, spawn } from "node:child_process";
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

/**
 * A single-line, markup-free summary of an event, suitable for a desktop
 * notification body or a shell argument (no Slack `*bold*`/`_italic_`). Used by
 * the exec notifier both as the appended CLI argument and as `AGENTRELAY_TEXT`.
 */
export function formatPlainText(payload: NotifyPayload): string {
  return `AgentRelay — ${payload.project} (${payload.event}): ${payload.message}`;
}

/**
 * Splits a command line into an argv array, honouring single quotes (literal),
 * double quotes (literal, with `\"`/`\\` escapes), and backslash escaping
 * outside quotes. This lets `AGENTRELAY_NOTIFY_COMMAND` hold paths/arguments
 * with spaces (`"/opt/My Tools/notify" --urgency low`) without ever going
 * through a shell — the exec notifier spawns the parsed argv directly, so there
 * is no shell-injection surface. Blank/whitespace-only input yields `[]`; an
 * unterminated quote is tolerated (the token so far is kept) rather than thrown.
 */
export function parseCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) {
        current += input[++i];
      } else if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      current += input[++i];
      hasToken = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
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

/**
 * Spawns the configured notify command. Injected in tests so exec delivery can
 * be asserted without launching a real process. Mirrors the subset of
 * `child_process.spawn` the exec notifier relies on.
 */
export type ExecSpawnFn = (
  command: string,
  args: string[],
  options: { env: Record<string, string | undefined> }
) => ChildProcess;

const defaultExecSpawn: ExecSpawnFn = (command, args, options) =>
  spawn(command, args, { env: options.env, stdio: "ignore" });

export interface ExecNotifierOptions {
  /**
   * Parsed argv of the command to run per event. Element 0 is the executable;
   * the remaining elements are base arguments. The event's plain-text summary
   * is appended as a final argument, so `notify-send AgentRelay` becomes
   * `notify-send AgentRelay "<text>"` (summary + body) out of the box.
   */
  command: string[];
  /** Injected for tests; defaults to a real `child_process.spawn`. */
  spawnFn?: ExecSpawnFn;
  /** Called when the command can't be spawned or exits non-zero. Defaults to a stderr warning. */
  onError?: (error: unknown) => void;
}

/**
 * Returns a Notifier that runs a local command for every queue event — the
 * missing channel for a local-first tool: wire `notify-send`, `terminal-notifier`,
 * or `osascript` to get a native desktop notification when a job resumes or
 * completes, with no HTTP server or webhook receiver.
 *
 * The command is spawned as a parsed argv (never through a shell, so there is no
 * injection surface). Each event's fields are exported to the child as
 * `AGENTRELAY_EVENT`/`AGENTRELAY_PROJECT`/`AGENTRELAY_JOB_ID`/`AGENTRELAY_MESSAGE`/
 * `AGENTRELAY_TEXT` (for wrapper scripts), and the plain-text summary is appended
 * as the final CLI argument (for `notify-send`-style tools). Spawn failures and
 * non-zero exits are reported through `onError` but never thrown — a broken
 * notify command must not take down the relay loop.
 */
export function createExecNotifier(options: ExecNotifierOptions): Notifier {
  const spawnFn = options.spawnFn ?? defaultExecSpawn;
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error(`[agentrelay] Notify command failed: ${String(error)}`);
    });
  const [executable, ...baseArgs] = options.command;

  return (payload: NotifyPayload) =>
    new Promise<void>((resolve) => {
      if (!executable) {
        onError(new Error("notify command is empty"));
        resolve();
        return;
      }
      const text = formatPlainText(payload);
      const env: Record<string, string | undefined> = {
        ...process.env,
        AGENTRELAY_EVENT: payload.event,
        AGENTRELAY_PROJECT: payload.project,
        AGENTRELAY_JOB_ID: payload.jobId,
        AGENTRELAY_MESSAGE: payload.message,
        AGENTRELAY_TEXT: text,
      };
      let child: ChildProcess;
      try {
        child = spawnFn(executable, [...baseArgs, text], { env });
      } catch (error) {
        onError(error);
        resolve();
        return;
      }
      // A failed spawn (e.g. ENOENT) can emit both `error` and `close`; settle
      // and report at most once so a single failure isn't double-logged.
      let settled = false;
      const settle = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (error !== undefined) onError(error);
        resolve();
      };
      child.on("error", (error) => settle(error));
      child.on("close", (code) => {
        settle(code !== null && code !== 0 ? new Error(`notify command exited with code ${code}`) : undefined);
      });
    });
}

/**
 * Builds an exec notifier from `AGENTRELAY_NOTIFY_COMMAND` (a command line,
 * quote-aware via {@link parseCommandLine}). Returns null when the variable is
 * unset/blank, or parses to no tokens, so callers can silently skip it.
 */
export function execNotifierFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: Omit<ExecNotifierOptions, "command"> = {}
): Notifier | null {
  const raw = env.AGENTRELAY_NOTIFY_COMMAND?.trim();
  if (!raw) return null;
  const command = parseCommandLine(raw);
  if (command.length === 0) return null;
  return createExecNotifier({ command, ...options });
}

/**
 * Assembles the notifier configured through the environment: Slack
 * (`AGENTRELAY_SLACK_WEBHOOK`), a generic webhook (`AGENTRELAY_WEBHOOK_URL`),
 * and/or a local command (`AGENTRELAY_NOTIFY_COMMAND`), fanned out together.
 * Returns null when none is configured, so callers can report "notifications
 * off" and skip work.
 */
export function notifiersFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: { fetchFn?: typeof fetch; onError?: (error: unknown) => void } = {}
): Notifier | null {
  const configured = [
    slackNotifierFromEnv(env, options),
    webhookNotifierFromEnv(env, options),
    execNotifierFromEnv(env, { onError: options.onError }),
  ].filter((n): n is Notifier => typeof n === "function");
  if (configured.length === 0) return null;
  return combineNotifiers(...configured);
}

export type NotifyChannelKind = "slack" | "webhook" | "exec";

/** A notification channel configured through the environment. */
export interface NotifyChannel {
  kind: NotifyChannelKind;
  /** Human-readable label ("Slack" / "Webhook" / "Command"). */
  label: string;
  /**
   * Destination descriptor — a webhook URL for HTTP channels, or the command
   * line for the exec channel. Displayed masked (treat as a secret).
   */
  url: string;
  /** The environment variable the value was read from. */
  envVar: string;
}

/**
 * Enumerates the notify channels configured through the environment, in a
 * stable order (Slack, then the generic webhook, then the exec command).
 * Blank/whitespace-only values are skipped so an empty env var doesn't
 * masquerade as a channel. This is the single source of truth for "which
 * channels are configured"; {@link sendTestNotification} builds on it.
 */
export function listNotifyChannels(env: Record<string, string | undefined> = process.env): NotifyChannel[] {
  const channels: NotifyChannel[] = [];
  const slack = env.AGENTRELAY_SLACK_WEBHOOK?.trim();
  if (slack) {
    channels.push({ kind: "slack", label: "Slack", url: slack, envVar: "AGENTRELAY_SLACK_WEBHOOK" });
  }
  const webhook = env.AGENTRELAY_WEBHOOK_URL?.trim();
  if (webhook) {
    channels.push({ kind: "webhook", label: "Webhook", url: webhook, envVar: "AGENTRELAY_WEBHOOK_URL" });
  }
  const command = env.AGENTRELAY_NOTIFY_COMMAND?.trim();
  if (command) {
    channels.push({ kind: "exec", label: "Command", url: command, envVar: "AGENTRELAY_NOTIFY_COMMAND" });
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
  /** Injected for tests; defaults to a real `child_process.spawn` (exec channel). */
  spawnFn?: ExecSpawnFn;
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
  const channels = listNotifyChannels(env);
  return Promise.all(
    channels.map(async (channel): Promise<TestNotifyResult> => {
      let captured: unknown;
      const onError = (error: unknown) => {
        captured = error;
      };
      const notifier =
        channel.kind === "slack"
          ? createSlackNotifier({ webhookUrl: channel.url, fetchFn: options.fetchFn, onError })
          : channel.kind === "exec"
            ? createExecNotifier({ command: parseCommandLine(channel.url), spawnFn: options.spawnFn, onError })
            : createWebhookNotifier({
                url: channel.url,
                headers: webhookAuthHeader(env),
                fetchFn: options.fetchFn,
                onError,
              });
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
