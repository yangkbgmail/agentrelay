import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  combineNotifiers,
  createExecNotifier,
  createSlackNotifier,
  createWebhookNotifier,
  type ExecSpawnFn,
  execNotifierFromEnv,
  formatPlainText,
  formatSlackText,
  listNotifyChannels,
  notifiersFromEnv,
  parseCommandLine,
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

  it("includes the exec command channel in the fan-out", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const onError = vi.fn();
    // Real spawn of a non-existent command surfaces ENOENT through onError
    // rather than crashing; exec delivery itself is covered with an injected
    // spawn elsewhere. The point here is that the channel is wired in.
    const notify = notifiersFromEnv({ AGENTRELAY_NOTIFY_COMMAND: "agentrelay-nonexistent-cmd" }, { fetchFn, onError });
    expect(notify).not.toBeNull();
    await expect(notify!(payload)).resolves.toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
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

  it("lists the exec command channel last, after the HTTP channels", () => {
    const channels = listNotifyChannels({
      AGENTRELAY_NOTIFY_COMMAND: "notify-send AgentRelay",
      AGENTRELAY_SLACK_WEBHOOK: "https://hooks.slack.test/abc",
    });
    expect(channels).toEqual([
      { kind: "slack", label: "Slack", url: "https://hooks.slack.test/abc", envVar: "AGENTRELAY_SLACK_WEBHOOK" },
      { kind: "exec", label: "Command", url: "notify-send AgentRelay", envVar: "AGENTRELAY_NOTIFY_COMMAND" },
    ]);
  });
});

/**
 * A minimal ChildProcess stand-in: an EventEmitter that emits `close` with the
 * given code on the next microtask, so the exec notifier's promise resolves.
 * `errorMode` instead emits an `error` event (spawn-time failure like ENOENT).
 */
function fakeSpawn(options: { code?: number; error?: Error } = {}): {
  spawnFn: ExecSpawnFn;
  calls: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }>;
} {
  const calls: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }> = [];
  const spawnFn: ExecSpawnFn = (command, args, opts) => {
    calls.push({ command, args, env: opts.env });
    const child = new EventEmitter();
    queueMicrotask(() => {
      if (options.error) child.emit("error", options.error);
      else child.emit("close", options.code ?? 0);
    });
    // The notifier only uses .on("error"/"close"); EventEmitter satisfies that.
    return child as unknown as ReturnType<ExecSpawnFn>;
  };
  return { spawnFn, calls };
}

describe("parseCommandLine", () => {
  it("splits plain whitespace-separated tokens", () => {
    expect(parseCommandLine("notify-send AgentRelay")).toEqual(["notify-send", "AgentRelay"]);
    expect(parseCommandLine("  osascript   -e  ")).toEqual(["osascript", "-e"]);
  });

  it("keeps quoted segments (with spaces) as single tokens", () => {
    expect(parseCommandLine('"/opt/My Tools/notify" --title "Hello World"')).toEqual([
      "/opt/My Tools/notify",
      "--title",
      "Hello World",
    ]);
    expect(parseCommandLine("say 'it works'")).toEqual(["say", "it works"]);
  });

  it("honours backslash escapes inside and outside double quotes", () => {
    expect(parseCommandLine("a\\ b")).toEqual(["a b"]);
    expect(parseCommandLine('"a\\"b"')).toEqual(['a"b']);
  });

  it("returns [] for blank input and tolerates an unterminated quote", () => {
    expect(parseCommandLine("")).toEqual([]);
    expect(parseCommandLine("   ")).toEqual([]);
    expect(parseCommandLine('notify "unclosed')).toEqual(["notify", "unclosed"]);
  });
});

describe("formatPlainText", () => {
  it("is a single markup-free line with project, event, and message", () => {
    const text = formatPlainText(payload);
    expect(text).toBe("AgentRelay — my-project (queued): " + payload.message);
    expect(text).not.toContain("*");
    expect(text).not.toContain("\n");
  });
});

describe("createExecNotifier", () => {
  it("spawns the executable with base args + appended text and injects event env vars", async () => {
    const { spawnFn, calls } = fakeSpawn();
    const notify = createExecNotifier({ command: ["notify-send", "AgentRelay"], spawnFn });

    await notify(payload);

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("notify-send");
    expect(calls[0].args).toEqual(["AgentRelay", formatPlainText(payload)]);
    expect(calls[0].env.AGENTRELAY_EVENT).toBe("queued");
    expect(calls[0].env.AGENTRELAY_PROJECT).toBe("my-project");
    expect(calls[0].env.AGENTRELAY_JOB_ID).toBe("job-123");
    expect(calls[0].env.AGENTRELAY_MESSAGE).toBe(payload.message);
    expect(calls[0].env.AGENTRELAY_TEXT).toBe(formatPlainText(payload));
  });

  it("reports a non-zero exit through onError instead of throwing", async () => {
    const onError = vi.fn();
    const { spawnFn } = fakeSpawn({ code: 3 });
    const notify = createExecNotifier({ command: ["false"], spawnFn, onError });

    await expect(notify(payload)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain("code 3");
  });

  it("swallows a spawn 'error' event (e.g. ENOENT) so the relay loop never crashes", async () => {
    const onError = vi.fn();
    const { spawnFn } = fakeSpawn({ error: new Error("spawn nope ENOENT") });
    const notify = createExecNotifier({ command: ["nope"], spawnFn, onError });

    await expect(notify(payload)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain("ENOENT");
  });

  it("swallows a synchronous spawn throw", async () => {
    const onError = vi.fn();
    const spawnFn: ExecSpawnFn = () => {
      throw new Error("boom");
    };
    const notify = createExecNotifier({ command: ["x"], spawnFn, onError });

    await expect(notify(payload)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain("boom");
  });

  it("reports an empty command through onError without spawning", async () => {
    const onError = vi.fn();
    const { spawnFn, calls } = fakeSpawn();
    const notify = createExecNotifier({ command: [], spawnFn, onError });

    await expect(notify(payload)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("execNotifierFromEnv", () => {
  it("returns null when AGENTRELAY_NOTIFY_COMMAND is unset, blank, or all-whitespace", () => {
    expect(execNotifierFromEnv({})).toBeNull();
    expect(execNotifierFromEnv({ AGENTRELAY_NOTIFY_COMMAND: "   " })).toBeNull();
  });

  it("parses the command line and returns a working notifier", async () => {
    const { spawnFn, calls } = fakeSpawn();
    const notify = execNotifierFromEnv({ AGENTRELAY_NOTIFY_COMMAND: 'notify-send "My Title"' }, { spawnFn });
    expect(notify).not.toBeNull();

    await notify!(payload);
    expect(calls[0].command).toBe("notify-send");
    expect(calls[0].args).toEqual(["My Title", formatPlainText(payload)]);
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

  it("runs the exec channel via the injected spawn and reports it ok on exit 0", async () => {
    const { spawnFn, calls } = fakeSpawn({ code: 0 });
    const results = await sendTestNotification({
      env: { AGENTRELAY_NOTIFY_COMMAND: "notify-send AgentRelay" },
      spawnFn,
    });

    expect(results).toHaveLength(1);
    expect(results[0].channel.kind).toBe("exec");
    expect(results[0].ok).toBe(true);
    expect(calls[0].command).toBe("notify-send");
    expect(calls[0].env.AGENTRELAY_EVENT).toBe("completed");
  });

  it("reports the exec channel as failed on a non-zero exit", async () => {
    const { spawnFn } = fakeSpawn({ code: 127 });
    const results = await sendTestNotification({
      env: { AGENTRELAY_NOTIFY_COMMAND: "does-not-exist" },
      spawnFn,
    });
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain("127");
  });
});
