import { parseDuration } from "./prune.js";
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

export interface ThrottleNotifierOptions {
  /**
   * Minimum milliseconds that must elapse between two notifications that share a
   * key before the second is delivered. `<= 0` disables throttling entirely
   * (the inner notifier is returned unwrapped, so there is zero overhead).
   */
  minIntervalMs: number;
  /**
   * Derives the throttle bucket key for a payload. Defaults to the event type,
   * so a herd of identical events — e.g. twenty jobs all resuming the instant a
   * shared reset window opens — collapses to a single delivered notification.
   * Override it (e.g. `` (p) => `${p.project}:${p.event}` ``) to throttle per
   * project instead.
   */
  keyOf?: (payload: NotifyPayload) => string;
  /** Injected clock returning epoch ms, so tests can advance time deterministically. Defaults to `Date.now`. */
  now?: () => number;
  /** Invoked with each payload that is suppressed, for local logging/metrics. */
  onSuppress?: (payload: NotifyPayload) => void;
}

/**
 * Wraps a notifier so that, for each bucket key, at most one notification is
 * delivered per `minIntervalMs` window. Notifications arriving too soon after
 * the last delivered one for their key are dropped (and reported through
 * `onSuppress`). This tames notification spam when many jobs transition at once
 * — the classic case being a reset window opening and a whole herd of jobs
 * resuming in the same tick.
 *
 * The window state is kept in memory, so it only throttles across events seen
 * by the *same* long-lived process (i.e. a running `daemon`, where the notifier
 * is built once and reused every tick). A per-invocation `tick` starts with an
 * empty window, so throttling has no effect across separate one-shot ticks.
 *
 * Pure aside from the injected clock; never throws (a delivery failure is the
 * inner notifier's responsibility, and those swallow their own errors).
 */
export function createThrottledNotifier(inner: Notifier, options: ThrottleNotifierOptions): Notifier {
  if (!(options.minIntervalMs > 0)) return inner;
  const minIntervalMs = options.minIntervalMs;
  const keyOf = options.keyOf ?? ((payload: NotifyPayload) => payload.event);
  const clock = options.now ?? (() => Date.now());
  const lastSentAt = new Map<string, number>();

  return async (payload: NotifyPayload) => {
    const key = keyOf(payload);
    const now = clock();
    const previous = lastSentAt.get(key);
    if (previous !== undefined && now - previous < minIntervalMs) {
      options.onSuppress?.(payload);
      return;
    }
    lastSentAt.set(key, now);
    await inner(payload);
  };
}

/**
 * Reads the notification throttle window from `AGENTRELAY_NOTIFY_MIN_INTERVAL`
 * (a duration string like `30s`, `5m`, `1h`) and returns it in milliseconds.
 * Returns `0` — meaning throttling is *off* — when the variable is unset,
 * blank, unparseable, or non-positive, so a typo can never silently swallow
 * notifications (it just disables the throttle instead).
 */
export function notifyMinIntervalMsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.AGENTRELAY_NOTIFY_MIN_INTERVAL?.trim();
  if (!raw) return 0;
  const ms = parseDuration(raw);
  return ms !== null && ms > 0 ? ms : 0;
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
 * (`AGENTRELAY_WEBHOOK_URL`), fanned out together and — when
 * `AGENTRELAY_NOTIFY_MIN_INTERVAL` is a positive duration — wrapped in a
 * throttle so a herd of simultaneous events doesn't flood the channel. Returns
 * null when neither channel is configured, so callers can report
 * "notifications off" and skip work.
 */
export function notifiersFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: {
    fetchFn?: typeof fetch;
    onError?: (error: unknown) => void;
    /** Injected clock (epoch ms) forwarded to the throttle, for deterministic tests. */
    now?: () => number;
    /** Forwarded to the throttle: invoked for each notification suppressed by the min-interval window. */
    onSuppress?: (payload: NotifyPayload) => void;
  } = {}
): Notifier | null {
  const channelOptions = { fetchFn: options.fetchFn, onError: options.onError };
  const configured = [slackNotifierFromEnv(env, channelOptions), webhookNotifierFromEnv(env, channelOptions)].filter(
    (n): n is Notifier => typeof n === "function"
  );
  if (configured.length === 0) return null;
  const combined = combineNotifiers(...configured);
  return createThrottledNotifier(combined, {
    minIntervalMs: notifyMinIntervalMsFromEnv(env),
    now: options.now,
    onSuppress: options.onSuppress,
  });
}

export type NotifyChannelKind = "slack" | "webhook";

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
