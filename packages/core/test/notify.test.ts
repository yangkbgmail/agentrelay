import { describe, expect, it, vi } from "vitest";
import {
  combineNotifiers,
  createSlackNotifier,
  createWebhookNotifier,
  filterNotifierByEvents,
  formatSlackText,
  isNotifyEvent,
  listNotifyChannels,
  NOTIFY_EVENTS,
  notifiersFromEnv,
  notifyEventsFromEnv,
  parseNotifyEvents,
  sendTestNotification,
  slackNotifierFromEnv,
  testNotifyPayload,
  webhookNotifierFromEnv,
} from "../src/notify.js";
import type { NotifyPayload } from "../src/types.js";

const payload: NotifyPayload = {
  jobId: "job-123",
  project: "my-project",
  event: "queued",
  message: "Hit rate limit, re-queued until 2026-07-12T22:00:00.000Z",
};

function okResponse(status = 200): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

describe("createSlackNotifier", () => {
  it("POSTs the formatted event to the webhook URL", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const notify = createSlackNotifier({ webhookUrl: "https://hooks.slack.test/abc", fetchFn });

    await notify(payload);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.test/abc");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain("my-project");
    expect(body.text).toContain("queued");
    expect(body.text).toContain("job-123");
  });

  it("reports non-2xx responses through onError instead of throwing", async () => {
    const onError = vi.fn();
    const notify = createSlackNotifier({
      webhookUrl: "https://hooks.slack.test/abc",
      fetchFn: async () => okResponse(500),
      onError,
    });

    await expect(notify(payload)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain("500");
  });

  it("swallows network errors so the relay loop never crashes", async () => {
    const onError = vi.fn();
    const notify = createSlackNotifier({
      webhookUrl: "https://hooks.slack.test/abc",
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
      onError,
    });

    await expect(notify(payload)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("slackNotifierFromEnv", () => {
  it("returns null when AGENTRELAY_SLACK_WEBHOOK is unset or blank", () => {
    expect(slackNotifierFromEnv({})).toBeNull();
    expect(slackNotifierFromEnv({ AGENTRELAY_SLACK_WEBHOOK: "  " })).toBeNull();
  });

  it("returns a working notifier when the env var is set", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const notify = slackNotifierFromEnv({ AGENTRELAY_SLACK_WEBHOOK: "https://hooks.slack.test/xyz" }, { fetchFn });
    expect(notify).not.toBeNull();

    await notify!(payload);
    expect(fetchFn).toHaveBeenCalledWith("https://hooks.slack.test/xyz", expect.anything());
  });
});

describe("combineNotifiers", () => {
  it("fans out to every non-null notifier", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const notify = combineNotifiers(a, null, undefined, b);

    await notify(payload);

    expect(a).toHaveBeenCalledWith(payload);
    expect(b).toHaveBeenCalledWith(payload);
  });
});

describe("formatSlackText", () => {
  it("includes the event emoji, project, message, and job id", () => {
    const text = formatSlackText({ ...payload, event: "completed" });
    expect(text).toContain("✅");
    expect(text).toContain("my-project");
    expect(text).toContain(payload.message);
    expect(text).toContain("job-123");
  });
});

describe("createWebhookNotifier", () => {
  it("POSTs the structured payload plus a text field as JSON", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const notify = createWebhookNotifier({ url: "https://hooks.example.test/relay", fetchFn });

    await notify(payload);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example.test/relay");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body.jobId).toBe("job-123");
    expect(body.project).toBe("my-project");
    expect(body.event).toBe("queued");
    expect(body.message).toBe(payload.message);
    expect(body.text).toContain("my-project");
  });

  it("merges extra headers (e.g. Authorization) onto the request", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const notify = createWebhookNotifier({
      url: "https://hooks.example.test/relay",
      headers: { Authorization: "Bearer secret" },
      fetchFn,
    });

    await notify(payload);

    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  });

  it("supports a custom formatBody (e.g. Discord's { content })", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const notify = createWebhookNotifier({
      url: "https://discord.example.test/webhook",
      formatBody: (p) => ({ content: `relay:${p.event}` }),
      fetchFn,
    });

    await notify(payload);

    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ content: "relay:queued" });
  });

  it("reports non-2xx responses through onError instead of throwing", async () => {
    const onError = vi.fn();
    const notify = createWebhookNotifier({
      url: "https://hooks.example.test/relay",
      fetchFn: async () => okResponse(503),
      onError,
    });

    await expect(notify(payload)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain("503");
  });

  it("swallows network errors so the relay loop never crashes", async () => {
    const onError = vi.fn();
    const notify = createWebhookNotifier({
      url: "https://hooks.example.test/relay",
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
      onError,
    });

    await expect(notify(payload)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("webhookNotifierFromEnv", () => {
  it("returns null when AGENTRELAY_WEBHOOK_URL is unset or blank", () => {
    expect(webhookNotifierFromEnv({})).toBeNull();
    expect(webhookNotifierFromEnv({ AGENTRELAY_WEBHOOK_URL: "  " })).toBeNull();
  });

  it("returns a working notifier and applies AGENTRELAY_WEBHOOK_AUTH as Authorization", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const notify = webhookNotifierFromEnv(
      { AGENTRELAY_WEBHOOK_URL: "https://hooks.example.test/xyz", AGENTRELAY_WEBHOOK_AUTH: "Bearer t0ken" },
      { fetchFn }
    );
    expect(notify).not.toBeNull();

    await notify!(payload);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example.test/xyz");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t0ken");
  });
});

describe("notifiersFromEnv", () => {
  it("returns null when neither Slack nor webhook is configured", () => {
    expect(notifiersFromEnv({})).toBeNull();
  });

  it("fans a single event out to both Slack and the generic webhook", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const notify = notifiersFromEnv(
      {
        AGENTRELAY_SLACK_WEBHOOK: "https://hooks.slack.test/abc",
        AGENTRELAY_WEBHOOK_URL: "https://hooks.example.test/relay",
      },
      { fetchFn }
    );
    expect(notify).not.toBeNull();

    await notify!(payload);

    const calledUrls = fetchFn.mock.calls.map((c) => c[0]);
    expect(calledUrls).toContain("https://hooks.slack.test/abc");
    expect(calledUrls).toContain("https://hooks.example.test/relay");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("works with only the generic webhook configured", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const notify = notifiersFromEnv({ AGENTRELAY_WEBHOOK_URL: "https://hooks.example.test/relay" }, { fetchFn });
    expect(notify).not.toBeNull();

    await notify!(payload);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe("https://hooks.example.test/relay");
  });
});

describe("listNotifyChannels", () => {
  it("returns an empty list when nothing is configured", () => {
    expect(listNotifyChannels({})).toEqual([]);
    expect(listNotifyChannels({ AGENTRELAY_SLACK_WEBHOOK: "  ", AGENTRELAY_WEBHOOK_URL: "" })).toEqual([]);
  });

  it("lists Slack first, then the generic webhook, with source env vars", () => {
    const channels = listNotifyChannels({
      AGENTRELAY_WEBHOOK_URL: "https://hooks.example.test/relay",
      AGENTRELAY_SLACK_WEBHOOK: "https://hooks.slack.test/abc",
    });
    expect(channels).toEqual([
      { kind: "slack", label: "Slack", url: "https://hooks.slack.test/abc", envVar: "AGENTRELAY_SLACK_WEBHOOK" },
      { kind: "webhook", label: "Webhook", url: "https://hooks.example.test/relay", envVar: "AGENTRELAY_WEBHOOK_URL" },
    ]);
  });
});

describe("testNotifyPayload", () => {
  it("is a well-formed NotifyPayload", () => {
    const p = testNotifyPayload();
    expect(p.event).toBe("completed");
    expect(p.project).toBe("agentrelay");
    expect(typeof p.jobId).toBe("string");
    expect(p.message.length).toBeGreaterThan(0);
  });
});

describe("sendTestNotification", () => {
  it("returns an empty array when no channels are configured", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const results = await sendTestNotification({ env: {}, fetchFn });
    expect(results).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("delivers to every channel and reports each as ok on 2xx", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const results = await sendTestNotification({
      env: {
        AGENTRELAY_SLACK_WEBHOOK: "https://hooks.slack.test/abc",
        AGENTRELAY_WEBHOOK_URL: "https://hooks.example.test/relay",
      },
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(results.map((r) => r.channel.kind)).toEqual(["slack", "webhook"]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.every((r) => r.error === undefined)).toBe(true);
  });

  it("reports a per-channel failure without failing the other channels", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.includes("slack") ? okResponse(500) : okResponse(200)
    ) as unknown as typeof fetch;
    const results = await sendTestNotification({
      env: {
        AGENTRELAY_SLACK_WEBHOOK: "https://hooks.slack.test/abc",
        AGENTRELAY_WEBHOOK_URL: "https://hooks.example.test/relay",
      },
      fetchFn,
    });

    const slack = results.find((r) => r.channel.kind === "slack");
    const webhook = results.find((r) => r.channel.kind === "webhook");
    expect(slack?.ok).toBe(false);
    expect(slack?.error).toContain("500");
    expect(webhook?.ok).toBe(true);
  });

  it("captures thrown network errors as a failure message", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const results = await sendTestNotification({
      env: { AGENTRELAY_WEBHOOK_URL: "https://hooks.example.test/relay" },
      fetchFn,
    });
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain("ECONNREFUSED");
  });

  it("applies AGENTRELAY_WEBHOOK_AUTH as the Authorization header", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    await sendTestNotification({
      env: {
        AGENTRELAY_WEBHOOK_URL: "https://hooks.example.test/relay",
        AGENTRELAY_WEBHOOK_AUTH: "Bearer t0ken",
      },
      fetchFn,
    });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t0ken");
  });
});

function makePayload(event: NotifyPayload["event"]): NotifyPayload {
  return { jobId: "j", project: "p", event, message: `event ${event}` };
}

describe("parseNotifyEvents", () => {
  it("returns no filter for blank / whitespace input", () => {
    expect(parseNotifyEvents("")).toEqual({ events: null, unknown: [] });
    expect(parseNotifyEvents("   ")).toEqual({ events: null, unknown: [] });
    expect(parseNotifyEvents(",, ,")).toEqual({ events: null, unknown: [] });
  });

  it("filters to exactly the named events (case/space-insensitive)", () => {
    const { events, unknown } = parseNotifyEvents("Failed, completed ");
    expect(unknown).toEqual([]);
    expect([...(events ?? [])].sort()).toEqual(["completed", "failed"]);
  });

  it("dedupes repeated events", () => {
    const { events } = parseNotifyEvents("failed,failed,failed");
    expect([...(events ?? [])]).toEqual(["failed"]);
  });

  it("expands all / * to every event (no filter)", () => {
    for (const raw of ["all", "ALL", "*"]) {
      const { events } = parseNotifyEvents(raw);
      expect([...(events ?? [])].sort()).toEqual([...NOTIFY_EVENTS].sort());
    }
  });

  it("mutes everything for none / off (empty set)", () => {
    expect(parseNotifyEvents("none")).toEqual({ events: new Set(), unknown: [] });
    expect(parseNotifyEvents("OFF")).toEqual({ events: new Set(), unknown: [] });
    // an explicit mute wins even alongside real events
    expect(parseNotifyEvents("failed,none").events?.size).toBe(0);
  });

  it("fails open (no filter) when only unrecognized tokens are given, reporting them", () => {
    const { events, unknown } = parseNotifyEvents("faild, oops");
    expect(events).toBeNull();
    expect(unknown).toEqual(["faild", "oops"]);
  });

  it("keeps known events and reports the unknown ones alongside", () => {
    const { events, unknown } = parseNotifyEvents("failed, bogus");
    expect([...(events ?? [])]).toEqual(["failed"]);
    expect(unknown).toEqual(["bogus"]);
  });
});

describe("isNotifyEvent", () => {
  it("recognizes exactly the known events", () => {
    for (const event of NOTIFY_EVENTS) expect(isNotifyEvent(event)).toBe(true);
    expect(isNotifyEvent("nope")).toBe(false);
    expect(isNotifyEvent("Failed")).toBe(false); // case-sensitive guard
  });
});

describe("notifyEventsFromEnv", () => {
  it("reads AGENTRELAY_NOTIFY_EVENTS, defaulting to no filter", () => {
    expect(notifyEventsFromEnv({}).events).toBeNull();
    const { events } = notifyEventsFromEnv({ AGENTRELAY_NOTIFY_EVENTS: "failed" });
    expect([...(events ?? [])]).toEqual(["failed"]);
  });
});

describe("filterNotifierByEvents", () => {
  it("passes the notifier through unchanged when the filter is null", async () => {
    const seen: string[] = [];
    const inner = async (p: NotifyPayload) => {
      seen.push(p.event);
    };
    const wrapped = filterNotifierByEvents(inner, null);
    expect(wrapped).toBe(inner);
    await wrapped(makePayload("queued"));
    expect(seen).toEqual(["queued"]);
  });

  it("forwards only in-set events and drops the rest", async () => {
    const seen: string[] = [];
    const wrapped = filterNotifierByEvents(
      async (p) => {
        seen.push(p.event);
      },
      new Set(["failed"])
    );
    await wrapped(makePayload("queued"));
    await wrapped(makePayload("completed"));
    await wrapped(makePayload("failed"));
    expect(seen).toEqual(["failed"]);
  });

  it("swallows everything for an empty set (mute all)", async () => {
    const seen: string[] = [];
    const wrapped = filterNotifierByEvents(async (p) => {
      seen.push(p.event);
    }, new Set());
    for (const event of NOTIFY_EVENTS) await wrapped(makePayload(event));
    expect(seen).toEqual([]);
  });
});

describe("notifiersFromEnv event filtering", () => {
  it("delivers only the selected events end-to-end", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const notify = notifiersFromEnv(
      { AGENTRELAY_SLACK_WEBHOOK: "https://hooks.slack.test/x", AGENTRELAY_NOTIFY_EVENTS: "failed" },
      { fetchFn }
    );
    expect(notify).not.toBeNull();
    await notify?.(makePayload("queued"));
    await notify?.(makePayload("failed"));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).toContain("failed");
  });

  it("notifies on every event when the filter is unset", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const notify = notifiersFromEnv({ AGENTRELAY_SLACK_WEBHOOK: "https://hooks.slack.test/x" }, { fetchFn });
    for (const event of NOTIFY_EVENTS) await notify?.(makePayload(event));
    expect(fetchFn).toHaveBeenCalledTimes(NOTIFY_EVENTS.length);
  });

  it("mutes all channels for none without silencing configuration", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const notify = notifiersFromEnv(
      { AGENTRELAY_SLACK_WEBHOOK: "https://hooks.slack.test/x", AGENTRELAY_NOTIFY_EVENTS: "none" },
      { fetchFn }
    );
    // A channel IS configured, so the notifier is non-null...
    expect(notify).not.toBeNull();
    // ...but every event is dropped before any HTTP call.
    for (const event of NOTIFY_EVENTS) await notify?.(makePayload(event));
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns null when no channel is configured, regardless of the event filter", () => {
    expect(notifiersFromEnv({ AGENTRELAY_NOTIFY_EVENTS: "failed" })).toBeNull();
  });
});
