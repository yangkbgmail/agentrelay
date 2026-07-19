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

/**
 * Assembles the notifier configured through the environment: Slack
 * (`AGENTRELAY_SLACK_WEBHOOK`) and/or a generic webhook
 * (`AGENTRELAY_WEBHOOK_URL`), fanned out together. Returns null when neither
 * is configured, so callers can report "notifications off" and skip work.
 */
export function notifiersFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: { fetchFn?: typeof fetch; onError?: (error: unknown) => void } = {}
): Notifier | null {
  const configured = [slackNotifierFromEnv(env, options), webhookNotifierFromEnv(env, options)].filter(
    (n): n is Notifier => typeof n === "function"
  );
  if (configured.length === 0) return null;
  return combineNotifiers(...configured);
}

/** One of the notification transports AgentRelay can deliver through. */
export type NotifyChannelKind = "slack" | "webhook";

/**
 * A configured notification channel, as read from the environment. `url` is
 * the raw endpoint (Slack webhooks embed a secret token in the path, so
 * callers that display it should mask it). `headers` carries any auth the
 * channel needs (the webhook's `Authorization`).
 */
export interface NotifyChannel {
  kind: NotifyChannelKind;
  url: string;
  headers?: Record<string, string>;
}

/**
 * Lists the notification channels configured through the environment, in the
 * same order and from the same variables that `notifiersFromEnv` uses:
 * Slack (`AGENTRELAY_SLACK_WEBHOOK`) then generic webhook
 * (`AGENTRELAY_WEBHOOK_URL`, with `AGENTRELAY_WEBHOOK_AUTH` as the
 * `Authorization` header). Pure — reads env only, sends nothing. Returns an
 * empty array when no channel is configured.
 */
export function describeConfiguredChannels(env: Record<string, string | undefined> = process.env): NotifyChannel[] {
  const channels: NotifyChannel[] = [];
  const slack = env.AGENTRELAY_SLACK_WEBHOOK?.trim();
  if (slack) channels.push({ kind: "slack", url: slack });
  const webhook = env.AGENTRELAY_WEBHOOK_URL?.trim();
  if (webhook) {
    const auth = env.AGENTRELAY_WEBHOOK_AUTH?.trim();
    channels.push({ kind: "webhook", url: webhook, headers: auth ? { Authorization: auth } : undefined });
  }
  return channels;
}

/**
 * Builds the sample payload used by `agentrelay notify test`. Deterministic
 * (no clock/randomness) so the surrounding logic stays unit-testable. It
 * flows through the exact same `createSlackNotifier`/`createWebhookNotifier`
 * bodies as real events, so a channel that accepts this accepts real
 * notifications.
 */
export function buildTestPayload(): NotifyPayload {
  return {
    jobId: "test-notification",
    project: "agentrelay",
    event: "completed",
    message: "This is a test notification from AgentRelay. If you can read this, delivery works.",
  };
}

/** Per-channel outcome of a `notify test` delivery attempt. */
export interface TestNotifyResult {
  kind: NotifyChannelKind;
  /** Raw endpoint the attempt targeted (mask before display). */
  url: string;
  /** True when the endpoint accepted the POST (2xx and no transport error). */
  ok: boolean;
  /** Failure reason when `ok` is false (HTTP status text or thrown error). */
  error?: string;
}

export interface SendTestNotificationsOptions {
  /** Injected for tests; defaults to global fetch (Node >= 18). */
  fetchFn?: typeof fetch;
  /** Override the sample payload (defaults to `buildTestPayload()`). */
  payload?: NotifyPayload;
}

/**
 * Delivers a test notification to every channel configured in the
 * environment and reports each channel's outcome. Unlike the relay-loop
 * notifiers (which swallow failures so a broken webhook can't stop the
 * loop), this surfaces per-channel success/failure so the user can verify
 * their setup actually delivers — the gap `doctor` can't fill, since it only
 * checks that a channel is *configured*. Never throws: a channel that fails
 * is reported with `ok: false`, not raised. Returns `[]` when nothing is
 * configured.
 */
export async function sendTestNotifications(
  env: Record<string, string | undefined> = process.env,
  options: SendTestNotificationsOptions = {}
): Promise<TestNotifyResult[]> {
  const payload = options.payload ?? buildTestPayload();
  const channels = describeConfiguredChannels(env);
  const results: TestNotifyResult[] = [];
  for (const channel of channels) {
    let captured: unknown = null;
    const onError = (error: unknown) => {
      captured = error;
    };
    const notifier =
      channel.kind === "slack"
        ? createSlackNotifier({ webhookUrl: channel.url, fetchFn: options.fetchFn, onError })
        : createWebhookNotifier({
            url: channel.url,
            headers: channel.headers,
            fetchFn: options.fetchFn,
            onError,
          });
    // The notifier resolves after its single POST, reporting any failure
    // through `onError` (both non-2xx and thrown transport errors). No
    // captured error means the endpoint accepted the payload.
    await notifier(payload);
    results.push({
      kind: channel.kind,
      url: channel.url,
      ok: captured === null,
      error: captured === null ? undefined : errorMessage(captured),
    });
  }
  return results;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
