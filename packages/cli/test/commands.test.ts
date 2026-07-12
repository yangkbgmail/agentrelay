import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyPayload } from "@agentrelay/core";
import { listStatus, retryPolicyFromEnv, runCommand } from "../src/commands.js";

describe("retryPolicyFromEnv", () => {
  it("returns an empty override object when no env vars are set", () => {
    expect(retryPolicyFromEnv({})).toEqual({});
  });

  it("reads valid overrides from the environment", () => {
    const policy = retryPolicyFromEnv({
      AGENTRELAY_MAX_RETRIES: "3",
      AGENTRELAY_RETRY_BASE_MS: "2000",
      AGENTRELAY_RETRY_MAX_MS: "60000",
      AGENTRELAY_RETRY_FACTOR: "1.5",
    });
    expect(policy).toEqual({ maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 60000, factor: 1.5 });
  });

  it("ignores invalid values (negative, non-numeric, out-of-range factor)", () => {
    const policy = retryPolicyFromEnv({
      AGENTRELAY_MAX_RETRIES: "-1",
      AGENTRELAY_RETRY_BASE_MS: "abc",
      AGENTRELAY_RETRY_FACTOR: "1", // must be > 1
    });
    expect(policy).toEqual({});
  });

  it("allows maxRetries of 0 (disable retries)", () => {
    expect(retryPolicyFromEnv({ AGENTRELAY_MAX_RETRIES: "0" })).toEqual({ maxRetries: 0 });
  });
});

describe("runCommand", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-cli-test-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not queue a job when the command output has no rate-limit message", async () => {
    const stdout = new PassThrough();
    const result = await runCommand({
      command: ["node", "-e", "console.log('all good, task complete')"],
      storePath,
      stdout,
      stderr: new PassThrough(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.queuedJob).toBeNull();
    expect(listStatus(storePath)).toHaveLength(0);
  });

  it("queues a job when the command output contains a rate-limit message", async () => {
    const stdout = new PassThrough();
    const result = await runCommand({
      command: ["node", "-e", "console.log('Usage limit reached. Resets in 10m.')"],
      storePath,
      cwd: dir,
      stdout,
      stderr: new PassThrough(),
    });
    expect(result.queuedJob).not.toBeNull();
    expect(result.queuedJob?.status).toBe("waiting_for_reset");

    const jobs = listStatus(storePath);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].command).toEqual(["node", "-e", "console.log('Usage limit reached. Resets in 10m.')"]);
  });

  it("sends a 'queued' notification when a rate-limited command is enqueued", async () => {
    const notify = vi.fn(async (_payload: NotifyPayload) => {});
    const result = await runCommand({
      command: ["node", "-e", "console.log('Usage limit reached. Resets in 10m.')"],
      storePath,
      cwd: dir,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      notify,
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0][0];
    expect(payload.event).toBe("queued");
    expect(payload.jobId).toBe(result.queuedJob?.id);
    expect(payload.message).toContain(result.queuedJob?.resetAt);
  });

  it("does not notify when the command completes without a rate limit", async () => {
    const notify = vi.fn(async (_payload: NotifyPayload) => {});
    await runCommand({
      command: ["node", "-e", "console.log('all good')"],
      storePath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      notify,
    });
    expect(notify).not.toHaveBeenCalled();
  });
});
