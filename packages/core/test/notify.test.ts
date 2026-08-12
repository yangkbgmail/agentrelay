import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  combineNotifiers,
  createExecNotifier,
  createSlackNotifier,
  createWebhookNotifier,
  type ExecSpawnFn,
  execNotifierFromEnv,
  execNotifyEnv,
  formatSlackText,
  listNotifyChannels,
  notifiersFromEnv,
  sendTestNotification,
  slackNotifierFromEnv,
  testNotifyPayload,
  webhookNotifierFromEnv,
} from "../src/notify.js";
import type { NotifyPayload } from "../src/types.js";

/**
 * A fake `spawn` (shell mode) that records each call and drives the notifier's
 * `error`/`close` handlers on the next microtask — after `createExecNotifier`
 * has attached them. `behavior` decides how the "process" ends.
 */
function fakeSpawn(behavior: { code?: number | null; signal?: NodeJS.Signals; throwSync?: Error } = {}): {
  spawnFn: ExecSpawnFn;
  calls: Array<{ command: string; env: Record<string, string | undefined> }>;
} {
  const calls: Array<{ command: string; env: Record<string, string | undefined> }> = [];
  const spawnFn: ExecSpawnFn = (command, options) => {
    calls.push({ command, env: options.env });
    if (behavior.throwSync) throw behavior.throwSync;
    const listeners: { error?: (e: Error) => void; close?: (c: number | null, s: NodeJS.Signals | null) => void } = {};
    queueMicrotask(() => {
      if (behavior.signal) listeners.close?.(null, behavior.signal);
      else listeners.close?.(behavior.code ?? 0, null);
    });
    return {
      on(event: string, listener: (...args: never[]) => void) {
        if (event === "error") listeners.error = listener as (e: Error) => void;
        if (event === "close") listeners.close = listener as (c: number | null, s: NodeJS.Signals | null) => void;
        return this;
      },
    };
  };
  return { spawnFn, calls };
}

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

describe("execNotifyEnv", () => {
  it("maps the payload onto AGENTRELAY_* variables (and a formatted text)", () => {
    const env = execNotifyEnv({ ...payload, event: "completed" });
    expect(env.AGENTRELAY_EVENT).toBe("completed");
    expect(env.AGENTRELAY_PROJECT).toBe("my-project");
    expect(env.AGENTRELAY_JOB_ID).toBe("job-123");
    expect(env.AGENTRELAY_MESSAGE).toBe(payload.message);
    expect(env.AGENTRELAY_TEXT).toContain("my-project");
  });
});

describe("createExecNotifier", () => {
  it("spawns the command in shell mode with the payload merged onto the base env", async () => {
    const { spawnFn, calls } = fakeSpawn({ code: 0 });
    const notify = createExecNotifier({ command: "notify-send $AGENTRELAY_PROJECT", env: { PATH: "/bin" }, spawnFn });

    await expect(notify(payload)).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("notify-send $AGENTRELAY_PROJECT");
    // Base env is preserved and the event vars are layered on top.
    expect(calls[0].env.PATH).toBe("/bin");
    expect(calls[0].env.AGENTRELAY_EVENT).toBe("queued");
    expect(calls[0].env.AGENTRELAY_JOB_ID).toBe("job-123");
  });

  it("reports a non-zero exit through onError instead of throwing", async () => {
    const onError = vi.fn();
    const { spawnFn } = fakeSpawn({ code: 3 });
    const notify = createExecNotifier({ command: "false", spawnFn, onError });

    await expect(notify(payload)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain("code 3");
  });

  it("reports a kill-by-signal (e.g. the timeout killed it) through onError", async () => {
    const onError = vi.fn();
    const { spawnFn } = fakeSpawn({ signal: "SIGTERM" });
    const notify = createExecNotifier({ command: "sleep 1000", spawnFn, onError });

    await expect(notify(payload)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain("SIGTERM");
  });

  it("swallows a synchronous spawn throw so the relay loop never crashes", async () => {
    const onError = vi.fn();
    const { spawnFn } = fakeSpawn({ throwSync: new Error("EACCES") });
    const notify = createExecNotifier({ command: "bad", spawnFn, onError });

    await expect(notify(payload)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain("EACCES");
  });

  it("does NOT report an error on a clean (code 0) exit", async () => {
    const onError = vi.fn();
    const { spawnFn } = fakeSpawn({ code: 0 });
    const notify = createExecNotifier({ command: "true", spawnFn, onError });

    await notify(payload);
    expect(onError).not.toHaveBeenCalled();
  });

  it("really runs a shell command that reads the payload env (no mock)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentrelay-exec-"));
    const outfile = join(dir, "event.txt");
    try {
      // The message is passed via env, never spliced into the command line.
      const notify = createExecNotifier({
        command: `printf '%s|%s|%s' "$AGENTRELAY_EVENT" "$AGENTRELAY_PROJECT" "$AGENTRELAY_JOB_ID" > "${outfile}"`,
      });
      await notify({ ...payload, event: "resumed" });
      expect(readFileSync(outfile, "utf8")).toBe("resumed|my-project|job-123");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("execNotifierFromEnv", () => {
  it("returns null when AGENTRELAY_NOTIFY_EXEC is unset or blank", () => {
    expect(execNotifierFromEnv({})).toBeNull();
    expect(execNotifierFromEnv({ AGENTRELAY_NOTIFY_EXEC: "   " })).toBeNull();
  });

  it("returns a working notifier that runs the configured command", async () => {
    const { spawnFn, calls } = fakeSpawn({ code: 0 });
    const notify = execNotifierFromEnv({ AGENTRELAY_NOTIFY_EXEC: "beep" }, { spawnFn });
    expect(notify).not.toBeNull();

    await notify!(payload);
    expect(calls[0].command).toBe("beep");
  });
});

describe("notifiersFromEnv", () => {
  it("returns null when neither Slack nor webhook nor exec is configured", () => {
    expect(notifiersFromEnv({})).toBeNull();
  });

  it("fans a single event out to Slack, the webhook, and the exec command", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const { spawnFn, calls } = fakeSpawn({ code: 0 });
    const notify = notifiersFromEnv(
      {
        AGENTRELAY_SLACK_WEBHOOK: "https://hooks.slack.test/abc",
        AGENTRELAY_WEBHOOK_URL: "https://hooks.example.test/relay",
        AGENTRELAY_NOTIFY_EXEC: "log-event",
      },
      { fetchFn, spawnFn }
    );
    expect(notify).not.toBeNull();

    await notify!(payload);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("log-event");
  });

  it("works with only the exec command configured", async () => {
    const { spawnFn, calls } = fakeSpawn({ code: 0 });
    const notify = notifiersFromEnv({ AGENTRELAY_NOTIFY_EXEC: "beep" }, { spawnFn });
    expect(notify).not.toBeNull();

    await notify!(payload);
    expect(calls).toHaveLength(1);
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

  it("lists Slack first, then the generic webhook, then exec, with source env vars", () => {
    const channels = listNotifyChannels({
      AGENTRELAY_WEBHOOK_URL: "https://hooks.example.test/relay",
      AGENTRELAY_SLACK_WEBHOOK: "https://hooks.slack.test/abc",
      AGENTRELAY_NOTIFY_EXEC: "notify-send AgentRelay",
    });
    expect(channels).toEqual([
      { kind: "slack", label: "Slack", url: "https://hooks.slack.test/abc", envVar: "AGENTRELAY_SLACK_WEBHOOK" },
      { kind: "webhook", label: "Webhook", url: "https://hooks.example.test/relay", envVar: "AGENTRELAY_WEBHOOK_URL" },
      { kind: "exec", label: "Exec", url: "notify-send AgentRelay", envVar: "AGENTRELAY_NOTIFY_EXEC" },
    ]);
  });

  it("skips a blank exec command", () => {
    expect(listNotifyChannels({ AGENTRELAY_NOTIFY_EXEC: "   " })).toEqual([]);
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

  it("runs the exec channel's command and reports it as ok on a clean exit", async () => {
    const { spawnFn, calls } = fakeSpawn({ code: 0 });
    const results = await sendTestNotification({
      env: { AGENTRELAY_NOTIFY_EXEC: "notify-send" },
      spawnFn,
    });
    expect(results).toHaveLength(1);
    expect(results[0].channel.kind).toBe("exec");
    expect(results[0].ok).toBe(true);
    expect(calls[0].command).toBe("notify-send");
    // The synthetic test payload reaches the command via env.
    expect(calls[0].env.AGENTRELAY_EVENT).toBe("completed");
  });

  it("reports a failing exec command (non-zero exit) as a channel failure", async () => {
    const { spawnFn } = fakeSpawn({ code: 127 });
    const results = await sendTestNotification({
      env: { AGENTRELAY_NOTIFY_EXEC: "no-such-command" },
      spawnFn,
    });
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain("127");
  });
});
