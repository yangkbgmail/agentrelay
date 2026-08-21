import { parseDuration } from "./prune.js";
import type { Notifier } from "./scheduler.js";
import type { NotifyPayload } from "./types.js";

const EVENT_EMOJI: Record<NotifyPayload["event"], string> = {
  queued: "⏳",
  resumed: "▶️",
  completed: "✅",
  failed: "❌",
};

/**
 * Default per-request timeout for a notification POST: 10 seconds. Generous for
 * a healthy webhook, short enough that a hung endpoint can't stall the relay.
 */
export const DEFAULT_NOTIFY_TIMEOUT_MS = 10_000;

/**
 * Resolve the notification-request timeout (ms) from `AGENTRELAY_NOTIFY_TIMEOUT`.
 * Unset/blank → {@link DEFAULT_NOTIFY_TIMEOUT_MS}. An explicit
 * `0`/`off`/`none`/`disabled`/`no` → `null`, meaning *no* timeout (the historical
 * unbounded behavior, opt-in). Anything else is parsed as a duration (`15s`,
 * `500ms`, `2m`, …); an unparseable/negative value falls back to the default so
 * the safety net is never silently lost to a typo.
 */
export function notifyTimeoutMsFromEnv(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.AGENTRELAY_NOTIFY_TIMEOUT?.trim();
  if (raw === undefined || raw === "") return DEFAULT_NOTIFY_TIMEOUT_MS;
  if (/^(0|off|none|disabled|no)$/i.test(raw)) return null;
  const parsed = parseDuration(raw);
  return parsed !== null && parsed > 0 ? parsed : DEFAULT_NOTIFY_TIMEOUT_MS;
}

/**
 * POST with a bounded timeout. A notification endpoint that accepts the TCP
 * connection but never responds would otherwise leave `fetch` pending forever;
 * because the scheduler `await`s every notify inside a tick, one hung POST
 * silently wedges the whole relay loop — the "silent failure" class this project
 * keeps guarding against. `onError`-never-throws handles *rejections*, not a
 * promise that never settles, so a timeout is the complementary defense.
 *
 * The real `fetch` is aborted via the `AbortController` signal (freeing the
 * socket), but delivery is enforced with `Promise.race` so the bound holds even
 * for a `fetchFn` that ignores the signal (e.g. a test double). A post-timeout
 * rejection from the abandoned fetch is swallowed so it can't surface as an
 * unhandled rejection. `timeoutMs` `undefined` uses the default; `null`/`<= 0`/
 * non-finite disables the bound and awaits `fetchFn` directly.
 */
async function postWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number | null | undefined
): Promise<Response> {
  const effective = timeoutMs === undefined ? DEFAULT_NOTIFY_TIMEOUT_MS : timeoutMs;
  if (effective === null || !Number.isFinite(effective) || effective <= 0) {
    return fetchFn(url, init);
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`notification request timed out after ${effective}ms`));
    }, effective);
  });
  const request = fetchFn(url, { ...init, signal: controller.signal });
  // If the timeout wins the race, the aborted fetch may still reject later —
  // attach a no-op catch so that rejection is never "unhandled".
  request.catch(() => {});
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function formatSlackText(payload: NotifyPayload): string {
  return `${EVENT_EMOJI[payload.event]} *AgentRelay — ${payload.project}* (${payload.event})\n${payload.message}\n_job ${payload.jobId}_`;
}

export interface SlackNotifierOptions {
  webhookUrl: string;
  /** Injected for tests; defaults to global fetch (Node >= 18). */
  fetchFn?: typeof fetch;
  /** Called when the webhook request fails. Defaults to a stderr warning. */
  onError?: (error: unknown) => void;
  /**
   * Per-request timeout in ms. `undefined` → {@link DEFAULT_NOTIFY_TIMEOUT_MS};
   * `null`/`<= 0`/non-finite disables the bound. A hung webhook is reported
   * through `onError` (never thrown), just like any other delivery failure.
   */
  timeoutMs?: number | null;
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
      const response = await postWithTimeout(
        fetchFn,
        options.webhookUrl,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: formatSlackText(payload) }),
        },
        options.timeoutMs
      );
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
  return createSlackNotifier({ webhookUrl, timeoutMs: notifyTimeoutMsFromEnv(env), ...options });
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
  /**
   * Per-request timeout in ms. `undefined` → {@link DEFAULT_NOTIFY_TIMEOUT_MS};
   * `null`/`<= 0`/non-finite disables the bound. A hung endpoint is reported
   * through `onError` (never thrown), so it can't wedge the relay loop.
   */
  timeoutMs?: number | null;
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
      const response = await postWithTimeout(
        fetchFn,
        options.url,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...options.headers },
          body: JSON.stringify(formatBody(payload)),
        },
        options.timeoutMs
      );
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
  return createWebhookNotifier({ url, timeoutMs: notifyTimeoutMsFromEnv(env), ...options, headers });
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
  const timeoutMs = notifyTimeoutMsFromEnv(env);
  const channels = listNotifyChannels(env);
  return Promise.all(
    channels.map(async (channel): Promise<TestNotifyResult> => {
      let captured: unknown;
      const onError = (error: unknown) => {
        captured = error;
      };
      const notifier =
        channel.kind === "slack"
          ? createSlackNotifier({ webhookUrl: channel.url, fetchFn: options.fetchFn, onError, timeoutMs })
          : createWebhookNotifier({
              url: channel.url,
              headers: webhookAuthHeader(env),
              fetchFn: options.fetchFn,
              onError,
              timeoutMs,
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
