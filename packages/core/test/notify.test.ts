import { describe, expect, it, vi } from "vitest";
import {
  buildDesktopCommand,
  combineNotifiers,
  createDesktopNotifier,
  createSlackNotifier,
  createWebhookNotifier,
  desktopNotifierFromEnv,
  formatSlackText,
  isDesktopNotifyEnabled,
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

  it("spawns the desktop command when AGENTRELAY_DESKTOP_NOTIFY is on and reports ok", async () => {
    const spawnFn = vi.fn();
    const results = await sendTestNotification({
      env: { AGENTRELAY_DESKTOP_NOTIFY: "1" },
      platform: "linux",
      spawnFn,
    });
    expect(results).toHaveLength(1);
    expect(results[0].channel.kind).toBe("desktop");
    expect(results[0].ok).toBe(true);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0][0]).toBe("notify-send");
  });

  it("reports the desktop channel as failed on an unsupported platform", async () => {
    const spawnFn = vi.fn();
    const results = await sendTestNotification({
      env: { AGENTRELAY_DESKTOP_NOTIFY: "yes" },
      platform: "aix" as NodeJS.Platform,
      spawnFn,
    });
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain("aix");
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe("buildDesktopCommand", () => {
  const payload: NotifyPayload = {
    jobId: "job-1",
    project: "proj",
    event: "completed",
    message: "all done",
  };

  it("builds an osascript command on macOS", () => {
    const cmd = buildDesktopCommand("darwin", payload);
    expect(cmd?.command).toBe("osascript");
    expect(cmd?.args[0]).toBe("-e");
    expect(cmd?.args[1]).toContain("display notification");
    expect(cmd?.args[1]).toContain("all done");
  });

  it("escapes quotes/backslashes into the AppleScript literal so text can't break out", () => {
    const cmd = buildDesktopCommand("darwin", { ...payload, message: 'say "hi" \\ bye' });
    // The raw quote/backslash must appear escaped, never as a bare delimiter.
    expect(cmd?.args[1]).toContain('\\"hi\\"');
    expect(cmd?.args[1]).toContain("\\\\");
  });

  it("builds a notify-send command with title and body as separate argv on Linux", () => {
    const cmd = buildDesktopCommand("linux", payload);
    expect(cmd?.command).toBe("notify-send");
    expect(cmd?.args).toContain("--app-name=AgentRelay");
    expect(cmd?.args.some((a) => a.includes("proj"))).toBe(true);
    expect(cmd?.args.some((a) => a.includes("all done"))).toBe(true);
  });

  it("builds a PowerShell balloon command on Windows and doubles single quotes", () => {
    const cmd = buildDesktopCommand("win32", { ...payload, project: "o'brien" });
    expect(cmd?.command).toBe("powershell");
    expect(cmd?.args).toContain("-Command");
    const script = cmd?.args[cmd.args.length - 1] ?? "";
    expect(script).toContain("NotifyIcon");
    expect(script).toContain("o''brien");
  });

  it("returns null for an unsupported platform", () => {
    expect(buildDesktopCommand("aix" as NodeJS.Platform, payload)).toBeNull();
  });
});

describe("isDesktopNotifyEnabled", () => {
  it("is true only for recognised on-values (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "On"]) {
      expect(isDesktopNotifyEnabled({ AGENTRELAY_DESKTOP_NOTIFY: v })).toBe(true);
    }
  });

  it("is false when unset, blank, or an off-value", () => {
    expect(isDesktopNotifyEnabled({})).toBe(false);
    expect(isDesktopNotifyEnabled({ AGENTRELAY_DESKTOP_NOTIFY: "  " })).toBe(false);
    expect(isDesktopNotifyEnabled({ AGENTRELAY_DESKTOP_NOTIFY: "0" })).toBe(false);
    expect(isDesktopNotifyEnabled({ AGENTRELAY_DESKTOP_NOTIFY: "off" })).toBe(false);
  });
});

describe("createDesktopNotifier", () => {
  const payload: NotifyPayload = {
    jobId: "job-1",
    project: "proj",
    event: "resumed",
    message: "back to work",
  };

  it("spawns the platform command for an event", async () => {
    const spawnFn = vi.fn();
    const notify = createDesktopNotifier({ platform: "linux", spawnFn });
    await notify(payload);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [command, args] = spawnFn.mock.calls[0] as unknown as [string, string[]];
    expect(command).toBe("notify-send");
    expect(args.some((a) => a.includes("back to work"))).toBe(true);
  });

  it("routes an unsupported platform to onError without spawning or throwing", async () => {
    const spawnFn = vi.fn();
    const onError = vi.fn();
    const notify = createDesktopNotifier({ platform: "aix" as NodeJS.Platform, spawnFn, onError });
    await expect(notify(payload)).resolves.toBeUndefined();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain("aix");
  });

  it("swallows a spawn error so the relay loop never crashes", async () => {
    const onError = vi.fn();
    const notify = createDesktopNotifier({
      platform: "linux",
      spawnFn: () => {
        throw new Error("ENOENT: notify-send not found");
      },
      onError,
    });
    await expect(notify(payload)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain("ENOENT");
  });
});

describe("desktopNotifierFromEnv", () => {
  it("returns null when AGENTRELAY_DESKTOP_NOTIFY is off/unset", () => {
    expect(desktopNotifierFromEnv({})).toBeNull();
    expect(desktopNotifierFromEnv({ AGENTRELAY_DESKTOP_NOTIFY: "0" })).toBeNull();
  });

  it("returns a working notifier when enabled", async () => {
    const spawnFn = vi.fn();
    const notify = desktopNotifierFromEnv({ AGENTRELAY_DESKTOP_NOTIFY: "true" }, { platform: "linux", spawnFn });
    expect(notify).not.toBeNull();
    await notify!({ jobId: "j", project: "p", event: "queued", message: "m" });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});

describe("notifiersFromEnv with desktop", () => {
  it("fans out to Slack, webhook, and desktop together", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const spawnFn = vi.fn();
    const notify = notifiersFromEnv(
      {
        AGENTRELAY_SLACK_WEBHOOK: "https://hooks.slack.test/abc",
        AGENTRELAY_WEBHOOK_URL: "https://hooks.example.test/relay",
        AGENTRELAY_DESKTOP_NOTIFY: "1",
      },
      { fetchFn, spawnFn }
    );
    expect(notify).not.toBeNull();
    await notify!({ jobId: "j", project: "p", event: "completed", message: "m" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("works with only the desktop channel enabled", async () => {
    const spawnFn = vi.fn();
    const notify = notifiersFromEnv({ AGENTRELAY_DESKTOP_NOTIFY: "on" }, { spawnFn });
    expect(notify).not.toBeNull();
    await notify!({ jobId: "j", project: "p", event: "failed", message: "m" });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});

describe("listNotifyChannels with desktop", () => {
  it("appends the desktop channel (non-secret, with the OS command) when enabled", () => {
    const channels = listNotifyChannels({ AGENTRELAY_DESKTOP_NOTIFY: "1" }, "linux");
    expect(channels).toEqual([
      {
        kind: "desktop",
        label: "Desktop",
        url: "notify-send",
        envVar: "AGENTRELAY_DESKTOP_NOTIFY",
        secret: false,
      },
    ]);
  });

  it("does not list desktop when the flag is off", () => {
    expect(listNotifyChannels({ AGENTRELAY_DESKTOP_NOTIFY: "0" }, "linux")).toEqual([]);
  });
});
