import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  combineNotifiers,
  createFileNotifier,
  createSlackNotifier,
  createWebhookNotifier,
  fileNotifierFromEnv,
  formatLogLine,
  formatSlackText,
  listNotifyChannels,
  notifiersFromEnv,
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

describe("formatLogLine", () => {
  it("serializes the payload as one JSON line with a leading timestamp", () => {
    const line = formatLogLine(payload, "2026-08-12T10:00:00.000Z");
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      at: "2026-08-12T10:00:00.000Z",
      jobId: "job-123",
      project: "my-project",
      event: "queued",
      message: payload.message,
    });
    // Exactly one record per line (no embedded newlines).
    expect(line.trimEnd().includes("\n")).toBe(false);
  });
});

describe("createFileNotifier", () => {
  it("appends a JSONL record to the path via the injected appendFn", async () => {
    const appends: Array<[string, string]> = [];
    const notify = createFileNotifier({
      path: "/var/log/agentrelay.jsonl",
      appendFn: (path, data) => {
        appends.push([path, data]);
      },
      now: () => "2026-08-12T10:00:00.000Z",
    });

    await notify(payload);

    expect(appends).toHaveLength(1);
    expect(appends[0][0]).toBe("/var/log/agentrelay.jsonl");
    expect(JSON.parse(appends[0][1])).toMatchObject({ at: "2026-08-12T10:00:00.000Z", jobId: "job-123" });
  });

  it("reports a write failure through onError instead of throwing", async () => {
    const onError = vi.fn();
    const notify = createFileNotifier({
      path: "/nope/agentrelay.jsonl",
      appendFn: () => {
        throw new Error("ENOSPC");
      },
      onError,
    });

    await expect(notify(payload)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain("ENOSPC");
  });
});

describe("fileNotifierFromEnv", () => {
  it("returns null when AGENTRELAY_NOTIFY_LOG is unset or blank", () => {
    expect(fileNotifierFromEnv({})).toBeNull();
    expect(fileNotifierFromEnv({ AGENTRELAY_NOTIFY_LOG: "  " })).toBeNull();
  });

  it("returns a working notifier when the env var is set", async () => {
    const appends: Array<[string, string]> = [];
    const notify = fileNotifierFromEnv(
      { AGENTRELAY_NOTIFY_LOG: "/tmp/relay.jsonl" },
      { appendFn: (p, d) => void appends.push([p, d]), now: () => "2026-08-12T10:00:00.000Z" }
    );
    expect(notify).not.toBeNull();

    await notify!(payload);
    expect(appends).toHaveLength(1);
    expect(appends[0][0]).toBe("/tmp/relay.jsonl");
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

  it("fans out to the event log alongside the webhook (real fs.appendFile)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentrelay-notify-"));
    const logPath = join(dir, "events.jsonl");
    try {
      const fetchFn = vi.fn(async () => okResponse());
      const notify = notifiersFromEnv(
        { AGENTRELAY_WEBHOOK_URL: "https://hooks.example.test/relay", AGENTRELAY_NOTIFY_LOG: logPath },
        { fetchFn }
      );
      expect(notify).not.toBeNull();

      await notify!(payload);
      await notify!({ ...payload, event: "completed" });

      expect(fetchFn).toHaveBeenCalledTimes(2);
      const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toMatchObject({ jobId: "job-123", event: "queued" });
      expect(JSON.parse(lines[1])).toMatchObject({ event: "completed" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("works with only the event log configured", () => {
    expect(notifiersFromEnv({ AGENTRELAY_NOTIFY_LOG: "/tmp/relay.jsonl" })).not.toBeNull();
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

  it("appends the event log after the webhook, keyed off AGENTRELAY_NOTIFY_LOG", () => {
    const channels = listNotifyChannels({
      AGENTRELAY_SLACK_WEBHOOK: "https://hooks.slack.test/abc",
      AGENTRELAY_NOTIFY_LOG: "/var/log/relay.jsonl",
    });
    expect(channels).toEqual([
      { kind: "slack", label: "Slack", url: "https://hooks.slack.test/abc", envVar: "AGENTRELAY_SLACK_WEBHOOK" },
      { kind: "file", label: "Event log", url: "/var/log/relay.jsonl", envVar: "AGENTRELAY_NOTIFY_LOG" },
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

  it("delivers the test payload to the event-log channel via appendFn", async () => {
    const appends: Array<[string, string]> = [];
    const results = await sendTestNotification({
      env: { AGENTRELAY_NOTIFY_LOG: "/var/log/relay.jsonl" },
      appendFn: (p, d) => void appends.push([p, d]),
    });

    expect(results).toHaveLength(1);
    expect(results[0].channel.kind).toBe("file");
    expect(results[0].ok).toBe(true);
    expect(appends).toHaveLength(1);
    expect(appends[0][0]).toBe("/var/log/relay.jsonl");
    expect(JSON.parse(appends[0][1])).toMatchObject({ event: "completed", project: "agentrelay" });
  });

  it("reports an event-log write failure as a per-channel failure", async () => {
    const results = await sendTestNotification({
      env: { AGENTRELAY_NOTIFY_LOG: "/nope/relay.jsonl" },
      appendFn: () => {
        throw new Error("EACCES");
      },
    });
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain("EACCES");
  });
});
