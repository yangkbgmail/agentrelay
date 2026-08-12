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

/** Default time budget for an exec-notifier command before it's killed. */
export const DEFAULT_EXEC_TIMEOUT_MS = 10_000;

/**
 * A spawn function shaped like `child_process.spawn(command, options)` in shell
 * mode. Only the two lifecycle events the notifier needs are typed, so tests can
 * substitute a lightweight fake without a real subprocess.
 */
export type ExecSpawnFn = (
  command: string,
  options: { env: Record<string, string | undefined>; shell: true; stdio: "ignore"; timeout: number }
) => {
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
};

export interface ExecNotifierOptions {
  /** Shell command run once per queue event (e.g. `notify-send "AgentRelay" "$AGENTRELAY_MESSAGE"`). */
  command: string;
  /** Base environment the command inherits. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Kill the command after this many ms so a hung hook can't wedge the relay. */
  timeoutMs?: number;
  /** Injected for tests; defaults to `child_process.spawn` in shell mode. */
  spawnFn?: ExecSpawnFn;
  /** Called when the command errors or exits non-zero. Defaults to a stderr warning. */
  onError?: (error: unknown) => void;
}

/**
 * Builds the event-describing environment variables handed to an exec-notifier
 * command. The payload is passed *only* as env vars — never interpolated into
 * the command string — so a message full of shell metacharacters can't inject
 * anything. Exported so the shape is documented and testable.
 */
export function execNotifyEnv(payload: NotifyPayload): Record<string, string> {
  return {
    AGENTRELAY_EVENT: payload.event,
    AGENTRELAY_PROJECT: payload.project,
    AGENTRELAY_JOB_ID: payload.jobId,
    AGENTRELAY_MESSAGE: payload.message,
    AGENTRELAY_TEXT: formatSlackText(payload),
  };
}

/**
 * Returns a Notifier that runs a local shell command for every queue event —
 * the local-first channel HTTP webhooks can't cover (desktop toasts via
 * `notify-send`/`terminal-notifier`, a `say` announcement, appending to a log,
 * a custom script). Event data reaches the command through `AGENTRELAY_*`
 * environment variables (see {@link execNotifyEnv}), so nothing from the
 * (untrusted) message text is spliced into the command line.
 *
 * Like the HTTP notifiers, failures are reported through `onError` but never
 * thrown: a broken hook, a non-zero exit, or a command that runs past
 * `timeoutMs` (it's killed) must not take down the relay loop. The returned
 * promise resolves when the command finishes or fails, so the scheduler can
 * await delivery without ever hanging on it.
 */
export function createExecNotifier(options: ExecNotifierOptions): Notifier {
  const spawnFn = options.spawnFn ?? (spawn as unknown as ExecSpawnFn);
  const baseEnv = options.env ?? process.env;
  const timeout = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error(`[agentrelay] Exec notification failed: ${String(error)}`);
    });

  return (payload: NotifyPayload) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        const child = spawnFn(options.command, {
          env: { ...baseEnv, ...execNotifyEnv(payload) },
          shell: true,
          stdio: "ignore",
          timeout,
        });
        child.on("error", (error) => {
          onError(error);
          finish();
        });
        child.on("close", (code, signal) => {
          if (signal) {
            onError(new Error(`Exec notification command killed by signal ${signal}`));
          } else if (code !== 0 && code !== null) {
            onError(new Error(`Exec notification command exited with code ${code}`));
          }
          finish();
        });
      } catch (error) {
        // A synchronous spawn throw (e.g. an invalid command) is swallowed too.
        onError(error);
        finish();
      }
    });
}

/**
 * Builds an exec notifier from `AGENTRELAY_NOTIFY_EXEC`. Returns null when the
 * variable is unset/blank so callers can silently skip local-command delivery.
 */
export function execNotifierFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: Omit<ExecNotifierOptions, "command"> = {}
): Notifier | null {
  const command = env.AGENTRELAY_NOTIFY_EXEC?.trim();
  if (!command) return null;
  return createExecNotifier({ command, env, ...options });
}

/**
 * Assembles the notifier configured through the environment: Slack
 * (`AGENTRELAY_SLACK_WEBHOOK`), a generic webhook (`AGENTRELAY_WEBHOOK_URL`),
 * and/or a local command (`AGENTRELAY_NOTIFY_EXEC`), fanned out together.
 * Returns null when none is configured, so callers can report "notifications
 * off" and skip work.
 */
export function notifiersFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: { fetchFn?: typeof fetch; spawnFn?: ExecSpawnFn; onError?: (error: unknown) => void } = {}
): Notifier | null {
  const { spawnFn, ...httpOptions } = options;
  const configured = [
    slackNotifierFromEnv(env, httpOptions),
    webhookNotifierFromEnv(env, httpOptions),
    execNotifierFromEnv(env, { spawnFn, onError: options.onError }),
  ].filter((n): n is Notifier => typeof n === "function");
  if (configured.length === 0) return null;
  return combineNotifiers(...configured);
}

export type NotifyChannelKind = "slack" | "webhook" | "exec";

/** A notification channel configured through the environment. */
export interface NotifyChannel {
  kind: NotifyChannelKind;
  /** Human-readable label ("Slack" / "Webhook"). */
  label: string;
  /** Destination URL (treat as a secret when displaying). */
  url: string;
  /** The environment variable the URL was read from. */
  envVar: string;
}

/**
 * Enumerates the notify channels configured through the environment, in a
 * stable order (Slack first, then the generic webhook). Blank/whitespace-only
 * values are skipped so an empty env var doesn't masquerade as a channel.
 * This is the single source of truth for "which channels are configured";
 * {@link sendTestNotification} builds on it.
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
  const exec = env.AGENTRELAY_NOTIFY_EXEC?.trim();
  if (exec) {
    channels.push({ kind: "exec", label: "Exec", url: exec, envVar: "AGENTRELAY_NOTIFY_EXEC" });
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
  /** Injected for tests; defaults to `child_process.spawn` (used by the exec channel). */
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
      const notifier = buildTestNotifier(channel, { env, onError, fetchFn: options.fetchFn, spawnFn: options.spawnFn });
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

/**
 * Constructs the production notifier for one channel, wired to capture failures
 * through `onError`, so {@link sendTestNotification} exercises the exact
 * delivery path (body shape, auth header, spawned command) a real event takes.
 */
function buildTestNotifier(
  channel: NotifyChannel,
  deps: {
    env: Record<string, string | undefined>;
    onError: (error: unknown) => void;
    fetchFn?: typeof fetch;
    spawnFn?: ExecSpawnFn;
  }
): Notifier {
  switch (channel.kind) {
    case "slack":
      return createSlackNotifier({ webhookUrl: channel.url, fetchFn: deps.fetchFn, onError: deps.onError });
    case "webhook":
      return createWebhookNotifier({
        url: channel.url,
        headers: webhookAuthHeader(deps.env),
        fetchFn: deps.fetchFn,
        onError: deps.onError,
      });
    case "exec":
      return createExecNotifier({
        command: channel.url,
        env: deps.env,
        spawnFn: deps.spawnFn,
        onError: deps.onError,
      });
  }
}
