import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { NotifyPayload } from "@agentrelay/core";
import { isBackupFile, parseConfig, RelayQueue, sampleConfigJson } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backupStore,
  cancelJob,
  initConfig,
  listStatus,
  pruneJobs,
  retryJob,
  runCommand,
  validateConfigFile,
} from "../src/commands.js";

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

  it("infers the codex-cli tool and detects its seconds-based rate limit", async () => {
    // A bare "in 20s" wait is only recognized by the Codex adapter, which is
    // selected here by inference from a `codex`-named binary (symlinked to node
    // so the fake command actually runs and prints the message).
    const codexBin = join(dir, "codex");
    symlinkSync(process.execPath, codexBin);
    const result = await runCommand({
      command: [codexBin, "-e", "console.log('Rate limit reached. Please try again in 20s.')"],
      storePath,
      cwd: dir,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(result.queuedJob).not.toBeNull();
    expect(result.queuedJob?.tool).toBe("codex-cli");
    expect(result.queuedJob?.status).toBe("waiting_for_reset");
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

describe("cancelJob / retryJob", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-cli-control-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(status: "waiting_for_reset" | "failed" | "completed") {
    const queue = new RelayQueue(storePath);
    const job = queue.enqueue({ project: "demo", tool: "claude-code", command: ["claude"], cwd: dir });
    if (status === "waiting_for_reset") queue.markWaitingForReset(job.id, new Date(Date.now() + 60_000).toISOString());
    if (status === "failed") queue.markFailed(job.id, "boom");
    if (status === "completed") queue.markCompleted(job.id, "done");
    queue.close();
    return job.id;
  }

  it("cancels a pending job by short id prefix", () => {
    const id = seed("waiting_for_reset");
    const result = cancelJob(id.slice(0, 8), storePath);
    expect(result.ok).toBe(true);
    expect(result.job?.status).toBe("cancelled");
    expect(listStatus(storePath)[0].status).toBe("cancelled");
  });

  it("refuses to cancel an already-completed job", () => {
    const id = seed("completed");
    const result = cancelJob(id, storePath);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("already completed");
    expect(listStatus(storePath)[0].status).toBe("completed");
  });

  it("reports an unknown id without mutating the store", () => {
    seed("waiting_for_reset");
    const result = cancelJob("deadbeef", storePath);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no job matches");
  });

  it("requeues a failed job to resume now with a fresh attempt count", () => {
    const id = seed("failed");
    const result = retryJob(id, storePath);
    expect(result.ok).toBe(true);
    expect(result.job?.status).toBe("waiting_for_reset");
    expect(result.job?.attempts).toBe(0);
    expect(result.job?.lastError).toBeNull();
  });
});

describe("pruneJobs", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-prune-cli-test-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes finished jobs and reports the remaining count", () => {
    const queue = new RelayQueue(storePath);
    const done = queue.enqueue({ project: "a", tool: "claude-code", command: ["x"], cwd: "/tmp" });
    queue.markCompleted(done.id);
    const active = queue.enqueue({ project: "b", tool: "claude-code", command: ["y"], cwd: "/tmp" });
    queue.markWaitingForReset(active.id, new Date(Date.now() + 60_000).toISOString());
    queue.close();

    const { pruned, remaining } = pruneJobs({ storePath });
    expect(pruned.map((j) => j.id)).toEqual([done.id]);
    expect(remaining).toBe(1);
    expect(listStatus(storePath).map((j) => j.id)).toEqual([active.id]);
  });

  it("dry-run leaves the store intact but reports the projected remaining count", () => {
    const queue = new RelayQueue(storePath);
    const done = queue.enqueue({ project: "a", tool: "claude-code", command: ["x"], cwd: "/tmp" });
    queue.markCompleted(done.id);
    queue.close();

    const { pruned, remaining } = pruneJobs({ storePath, dryRun: true });
    expect(pruned).toHaveLength(1);
    expect(remaining).toBe(0);
    // Store untouched.
    expect(listStatus(storePath)).toHaveLength(1);
  });
});

describe("initConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-init-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the sample config to ./agentrelay.config.json by default", () => {
    const result = initConfig({ cwd: dir });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(join(dir, "agentrelay.config.json"));
    expect(existsSync(result.path)).toBe(true);
    // Content is the canonical sample and parses as a valid config.
    const written = readFileSync(result.path, "utf8");
    expect(written).toBe(sampleConfigJson());
    expect(() => parseConfig(JSON.parse(written))).not.toThrow();
  });

  it("honors an explicit relative path resolved against cwd", () => {
    const result = initConfig({ cwd: dir, path: "nested/my.json" });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(join(dir, "nested", "my.json"));
    expect(existsSync(result.path)).toBe(true); // parent dir created
  });

  it("refuses to overwrite an existing file without --force", () => {
    const path = join(dir, "agentrelay.config.json");
    writeFileSync(path, '{"store":"keep-me"}');
    const result = initConfig({ cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/already exists/);
    // Untouched.
    expect(readFileSync(path, "utf8")).toBe('{"store":"keep-me"}');
  });

  it("overwrites when force is set", () => {
    const path = join(dir, "agentrelay.config.json");
    writeFileSync(path, '{"store":"old"}');
    const result = initConfig({ cwd: dir, force: true });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Overwrote/);
    expect(readFileSync(path, "utf8")).toBe(sampleConfigJson());
  });
});

describe("validateConfigFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-validate-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes cleanly for the freshly generated sample config", () => {
    const path = join(dir, "agentrelay.config.json");
    initConfig({ cwd: dir });
    const result = validateConfigFile({ path });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(path);
    expect(result.issues).toEqual([]);
  });

  it("errors when no config file is found", () => {
    const result = validateConfigFile({ cwd: dir, env: { HOME: dir } });
    expect(result.ok).toBe(false);
    expect(result.path).toBeNull();
    expect(result.issues[0].message).toMatch(/no config file found/);
  });

  it("reports invalid JSON as a single error instead of throwing", () => {
    const path = join(dir, "agentrelay.config.json");
    writeFileSync(path, "{ not json");
    const result = validateConfigFile({ path });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([expect.objectContaining({ level: "error", path: "file" })]);
    expect(result.issues[0].message).toMatch(/invalid JSON/i);
  });

  it("reports a structural (wrong type) mistake as an error", () => {
    const path = join(dir, "agentrelay.config.json");
    writeFileSync(path, JSON.stringify({ retry: { maxAttempts: "lots" } }));
    const result = validateConfigFile({ path });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([expect.objectContaining({ level: "error", path: "structure" })]);
  });

  it("surfaces semantic issues (bad duration) with ok=false", () => {
    const path = join(dir, "agentrelay.config.json");
    writeFileSync(path, JSON.stringify({ autoPrune: { after: "whenever" } }));
    const result = validateConfigFile({ path });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([expect.objectContaining({ level: "error", path: "autoPrune.after" })]);
  });

  it("passes (ok=true) when only warnings are present", () => {
    const path = join(dir, "agentrelay.config.json");
    writeFileSync(path, JSON.stringify({ notify: { slackWebhook: "oops" } }));
    const result = validateConfigFile({ path });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([expect.objectContaining({ level: "warning", path: "notify.slackWebhook" })]);
  });
});

describe("backupStore", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-backup-test-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const seedStore = (contents: string) => writeFileSync(storePath, contents);
  const backupsInDir = () => readdirSync(dir).filter((n) => isBackupFile(n, "jobs.json"));

  it("copies the store byte-for-byte to a timestamped sibling", () => {
    const bytes = JSON.stringify([{ id: "a", project: "demo" }], null, 2);
    seedStore(bytes);

    const result = backupStore({ storePath, now: new Date("2026-07-18T13:38:10.351Z") });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(`${storePath}.bak-2026-07-18T13-38-10-351Z`);
    expect(result.kept).toBe(1);
    expect(readFileSync(result.path as string, "utf8")).toBe(bytes);
  });

  it("refuses (ok=false) when there is no store file yet", () => {
    const result = backupStore({ storePath });
    expect(result.ok).toBe(false);
    expect(result.path).toBeNull();
    expect(backupsInDir()).toHaveLength(0);
  });

  it("rotates old backups down to keepLast, keeping the newest", () => {
    seedStore("[]");
    const older = backupStore({ storePath, keepLast: 5, now: new Date("2026-07-18T10:00:00.000Z") });
    const middle = backupStore({ storePath, keepLast: 5, now: new Date("2026-07-18T11:00:00.000Z") });
    const newest = backupStore({ storePath, keepLast: 5, now: new Date("2026-07-18T12:00:00.000Z") });
    expect(backupsInDir()).toHaveLength(3);

    // Now cap at 2: the oldest backup is rotated out, the two newest remain.
    const result = backupStore({ storePath, keepLast: 2, now: new Date("2026-07-18T13:00:00.000Z") });
    expect(result.ok).toBe(true);
    // We wrote a 4th backup then trimmed to 2, so 2 of the earlier files are gone.
    expect(result.kept).toBe(2);
    expect(result.pruned).toContain(`jobs.json.bak-2026-07-18T10-00-00-000Z`);
    expect(existsSync(older.path as string)).toBe(false);
    expect(existsSync(middle.path as string)).toBe(false);
    expect(existsSync(newest.path as string)).toBe(true);
    expect(existsSync(result.path as string)).toBe(true);
    expect(backupsInDir()).toHaveLength(2);
  });
});
