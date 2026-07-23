import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { NotifyPayload, RelayJob } from "@agentrelay/core";
import { parseConfig, RelayQueue, sampleConfigJson } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backupStore,
  bulkControlJobs,
  cancelJob,
  getConfigValue,
  importStore,
  initConfig,
  listStatus,
  listStoreBackups,
  previewRestoreStore,
  pruneJobs,
  restoreStore,
  retryJob,
  runCommand,
  setConfigFile,
  showConfig,
  showJob,
  unsetConfigFile,
  validateConfigFile,
  waitForJob,
} from "../src/commands.js";
import {
  configGetValue,
  isConfigDiagnosticInvocation,
  renderConfigGetJson,
  renderConfigGetWithSource,
  renderEffectiveConfig,
  resolveProjectName,
} from "../src/config.js";

describe("resolveProjectName", () => {
  it("derives the label from the cwd's last path segment", () => {
    expect(resolveProjectName("/home/user/my-app")).toBe("my-app");
    expect(resolveProjectName("/home/user/my-app/")).toBe("my-app");
  });

  it("prefers a non-blank override over the derived name", () => {
    expect(resolveProjectName("/home/user/my-app", "billing")).toBe("billing");
    expect(resolveProjectName("/home/user/my-app", "  billing  ")).toBe("billing");
  });

  it("ignores a blank/whitespace override and falls back to the cwd", () => {
    expect(resolveProjectName("/home/user/my-app", "")).toBe("my-app");
    expect(resolveProjectName("/home/user/my-app", "   ")).toBe("my-app");
    expect(resolveProjectName("/home/user/my-app", undefined)).toBe("my-app");
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

  it("labels the queued job with an explicit --project override", async () => {
    const result = await runCommand({
      command: ["node", "-e", "console.log('Usage limit reached. Resets in 10m.')"],
      storePath,
      cwd: dir,
      project: "my-service",
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(result.queuedJob?.project).toBe("my-service");
    expect(listStatus(storePath)[0].project).toBe("my-service");
  });

  it("falls back to the cwd-derived project when --project is blank", async () => {
    const result = await runCommand({
      command: ["node", "-e", "console.log('Usage limit reached. Resets in 10m.')"],
      storePath,
      cwd: dir,
      project: "   ",
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    // dir is a mkdtemp path; its last segment is the derived label, never blank.
    expect(result.queuedJob?.project).toBe(dir.split("/").filter(Boolean).pop());
    expect(result.queuedJob?.project?.trim()).not.toBe("");
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

describe("bulkControlJobs", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-cli-bulk-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Seed a mixed store: 2 waiting, 1 failed, 1 completed across tools/projects. */
  function seedMixed() {
    const queue = new RelayQueue(storePath);
    const soon = () => new Date(Date.now() + 60_000).toISOString();
    const w1 = queue.enqueue({ project: "web", tool: "claude-code", command: ["claude"], cwd: dir });
    queue.markWaitingForReset(w1.id, soon());
    const w2 = queue.enqueue({ project: "api", tool: "codex-cli", command: ["codex"], cwd: dir });
    queue.markWaitingForReset(w2.id, soon());
    const f1 = queue.enqueue({ project: "web", tool: "claude-code", command: ["claude"], cwd: dir });
    queue.markFailed(f1.id, "boom");
    const c1 = queue.enqueue({ project: "api", tool: "claude-code", command: ["claude"], cwd: dir });
    queue.markCompleted(c1.id, "done");
    queue.close();
    return { w1: w1.id, w2: w2.id, f1: f1.id, c1: c1.id };
  }

  it("cancels every eligible job and skips terminal ones", () => {
    const ids = seedMixed();
    const result = bulkControlJobs("cancel", { storePath });
    // 2 waiting are eligible; failed + completed are skipped.
    expect(result.matched).toBe(4);
    expect(result.affected.map((j) => j.id).sort()).toEqual([ids.w1, ids.w2].sort());
    expect(result.skipped).toHaveLength(2);
    const after = listStatus(storePath);
    expect(after.filter((j) => j.status === "cancelled")).toHaveLength(2);
    expect(after.find((j) => j.id === ids.c1)?.status).toBe("completed");
  });

  it("scopes cancellation by tool", () => {
    const ids = seedMixed();
    const result = bulkControlJobs("cancel", { storePath, scope: { tools: ["codex-cli"] } });
    expect(result.matched).toBe(1);
    expect(result.affected.map((j) => j.id)).toEqual([ids.w2]);
    const after = listStatus(storePath);
    expect(after.find((j) => j.id === ids.w1)?.status).toBe("waiting_for_reset");
    expect(after.find((j) => j.id === ids.w2)?.status).toBe("cancelled");
  });

  it("scopes cancellation by project", () => {
    const ids = seedMixed();
    const result = bulkControlJobs("cancel", { storePath, scope: { projects: ["web"] } });
    // web has 1 waiting (eligible) + 1 failed (skipped).
    expect(result.matched).toBe(2);
    expect(result.affected.map((j) => j.id)).toEqual([ids.w1]);
    expect(result.skipped).toHaveLength(1);
  });

  it("retries every non-resuming job, resetting attempts", () => {
    seedMixed();
    const result = bulkControlJobs("retry", { storePath });
    // All four jobs are requeueable (none are mid-flight).
    expect(result.matched).toBe(4);
    expect(result.affected).toHaveLength(4);
    const after = listStatus(storePath);
    expect(after.every((j) => j.status === "waiting_for_reset")).toBe(true);
    expect(after.every((j) => j.attempts === 0)).toBe(true);
  });

  it("dry-run reports the effect without mutating the store", () => {
    seedMixed();
    const result = bulkControlJobs("cancel", { storePath, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.affected).toHaveLength(2);
    expect(result.message).toContain("would cancel");
    // Nothing changed on disk.
    const after = listStatus(storePath);
    expect(after.filter((j) => j.status === "cancelled")).toHaveLength(0);
  });

  it("reports zero matched when the scope excludes everything", () => {
    seedMixed();
    const result = bulkControlJobs("cancel", { storePath, scope: { projects: ["nope"] } });
    expect(result.matched).toBe(0);
    expect(result.affected).toHaveLength(0);
    expect(result.message).toContain("0 job(s)");
  });
});

describe("showJob", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-show-cli-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a job by short id prefix and returns it unmutated", () => {
    const queue = new RelayQueue(storePath);
    const job = queue.enqueue({ project: "demo", tool: "claude-code", command: ["claude", "-p", "go"], cwd: dir });
    queue.markWaitingForReset(job.id, new Date(Date.now() + 60_000).toISOString());
    queue.close();

    const result = showJob(job.id.slice(0, 8), storePath);
    expect(result.ok).toBe(true);
    expect(result.job?.id).toBe(job.id);
    expect(result.job?.status).toBe("waiting_for_reset");
    // Read-only: the store is unchanged.
    expect(listStatus(storePath)[0].status).toBe("waiting_for_reset");
  });

  it("reports an unknown id as not ok", () => {
    const queue = new RelayQueue(storePath);
    queue.enqueue({ project: "demo", tool: "claude-code", command: ["claude"], cwd: dir });
    queue.close();

    const result = showJob("deadbeef", storePath);
    expect(result.ok).toBe(false);
    expect(result.job).toBeNull();
    expect(result.error).toMatch(/no job matches/);
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

describe("setConfigFile / unsetConfigFile", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-cfgset-"));
    path = join(dir, "agentrelay.config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file on first set with pretty JSON", () => {
    const result = setConfigFile({ key: "retry.maxAttempts", value: "7", path });
    expect(result.ok).toBe(true);
    expect(existsSync(path)).toBe(true);
    const written = readFileSync(path, "utf8");
    expect(written.endsWith("\n")).toBe(true);
    expect(parseConfig(JSON.parse(written))).toEqual({ retry: { maxAttempts: 7 } });
    expect(result.message).toMatch(/Set retry.maxAttempts = 7/);
  });

  it("merges into an existing file, preserving other values", () => {
    writeFileSync(path, JSON.stringify({ store: "/keep.json", retry: { factor: 3 } }));
    const result = setConfigFile({ key: "retry.maxAttempts", value: "9", path });
    expect(result.ok).toBe(true);
    expect(parseConfig(JSON.parse(readFileSync(path, "utf8")))).toEqual({
      store: "/keep.json",
      retry: { factor: 3, maxAttempts: 9 },
    });
  });

  it("masks a secret value in the confirmation message", () => {
    const result = setConfigFile({ key: "notify.webhookAuth", value: "Bearer super-secret", path });
    expect(result.ok).toBe(true);
    expect(result.message).not.toMatch(/super-secret/);
    expect(result.message).toMatch(/\*\*\*/);
    // ...but the real value is written to the file.
    expect(parseConfig(JSON.parse(readFileSync(path, "utf8")))).toEqual({
      notify: { webhookAuth: "Bearer super-secret" },
    });
  });

  it("refuses an unknown key and does not write", () => {
    const result = setConfigFile({ key: "retry.bogus", value: "1", path });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Unknown config key/);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a value that fails semantic validation (factor < 1)", () => {
    const result = setConfigFile({ key: "retry.factor", value: "0.5", path });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/at least 1/);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a type-mismatched value (non-number)", () => {
    const result = setConfigFile({ key: "retry.maxAttempts", value: "many", path });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/finite number/);
  });

  it("errors clearly on a malformed existing file instead of clobbering it", () => {
    writeFileSync(path, "{ not json");
    const result = setConfigFile({ key: "store", value: "/x.json", path });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Invalid JSON/);
    // Original bytes preserved.
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  it("unset removes a value and drops the emptied group", () => {
    writeFileSync(path, JSON.stringify({ retry: { maxAttempts: 5 } }));
    const result = unsetConfigFile({ key: "retry.maxAttempts", path });
    expect(result.ok).toBe(true);
    expect(parseConfig(JSON.parse(readFileSync(path, "utf8")))).toEqual({});
  });

  it("unset reports when there is no file to edit", () => {
    const result = unsetConfigFile({ key: "store", path });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/No config file/);
  });

  it("unset rejects an unknown key", () => {
    writeFileSync(path, "{}");
    const result = unsetConfigFile({ key: "retry.bogus", path });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Unknown config key/);
  });
});

describe("backupStore / listStoreBackups", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-backup-cli-test-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a snapshot of the store and reports the job count", () => {
    const queue = new RelayQueue(storePath);
    queue.enqueue({ project: "demo", tool: "claude-code", command: ["claude"], cwd: "/tmp" });
    queue.close();

    const result = backupStore({ storePath });
    expect(result.jobCount).toBe(1);
    expect(existsSync(result.path)).toBe(true);
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toHaveLength(1);
  });

  it("lists snapshots newest first and returns [] when there are none", () => {
    expect(listStoreBackups(storePath)).toEqual([]);

    const queue = new RelayQueue(storePath);
    queue.close();
    queue.backup({ now: new Date("2026-07-18T09:00:01.000Z") });
    queue.backup({ now: new Date("2026-07-18T09:00:02.000Z") });

    const backups = listStoreBackups(storePath);
    expect(backups).toHaveLength(2);
    // Newest first.
    expect(backups[0].stamp).toBe("2026-07-18T09-00-02-000Z");
    expect(backups[1].stamp).toBe("2026-07-18T09-00-01-000Z");
  });
});

describe("restoreStore", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-restore-cli-test-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("restores the latest snapshot by default and reports the job count", () => {
    const queue = new RelayQueue(storePath);
    queue.enqueue({ project: "demo", tool: "claude-code", command: ["claude"], cwd: "/tmp" });
    queue.backup({ now: new Date("2026-07-18T09:00:01.000Z") });
    // Grow the store beyond the snapshot.
    queue.enqueue({ project: "extra", tool: "generic", command: ["x"], cwd: "/tmp" });
    queue.close();
    expect(listStatus(storePath)).toHaveLength(2);

    const result = restoreStore({ storePath });
    expect(result.jobCount).toBe(1);
    expect(result.from.endsWith("jobs.json.backup-2026-07-18T09-00-01-000Z")).toBe(true);
    expect(result.backedUpTo).not.toBeNull();
    // Store is back to the single snapshotted job.
    expect(listStatus(storePath)).toHaveLength(1);
  });

  it("restores a specific snapshot by its stamp", () => {
    const queue = new RelayQueue(storePath);
    queue.enqueue({ project: "one", tool: "generic", command: ["a"], cwd: "/tmp" });
    queue.backup({ now: new Date("2026-07-18T09:00:01.000Z") });
    queue.enqueue({ project: "two", tool: "generic", command: ["b"], cwd: "/tmp" });
    queue.backup({ now: new Date("2026-07-18T09:00:02.000Z") });
    queue.close();

    // Restore the older (1-job) snapshot, not the latest (2-job) one.
    const result = restoreStore({ storePath, selector: "2026-07-18T09-00-01-000Z" });
    expect(result.jobCount).toBe(1);
    expect(listStatus(storePath)).toHaveLength(1);
  });

  it("throws a clear error when no snapshot matches the selector", () => {
    const queue = new RelayQueue(storePath);
    queue.enqueue({ project: "one", tool: "generic", command: ["a"], cwd: "/tmp" });
    queue.close();
    expect(() => restoreStore({ storePath, selector: "latest" })).toThrow(/No snapshot matches/);
  });
});

describe("previewRestoreStore", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-preview-restore-cli-test-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("previews the latest snapshot without changing the store", () => {
    const queue = new RelayQueue(storePath);
    queue.enqueue({ project: "demo", tool: "claude-code", command: ["claude"], cwd: "/tmp" });
    queue.backup({ now: new Date("2026-07-18T09:00:01.000Z") });
    queue.enqueue({ project: "extra", tool: "generic", command: ["x"], cwd: "/tmp" });
    queue.close();
    expect(listStatus(storePath)).toHaveLength(2);

    const preview = previewRestoreStore({ storePath });
    expect(preview.jobCount).toBe(1);
    expect(preview.currentJobCount).toBe(2);
    expect(preview.wouldBackUp).toBe(true);
    expect(preview.from.endsWith("jobs.json.backup-2026-07-18T09-00-01-000Z")).toBe(true);

    // The store and its backups are untouched by the dry run.
    expect(listStatus(storePath)).toHaveLength(2);
    expect(listStoreBackups(storePath)).toHaveLength(1);
  });

  it("reports wouldBackUp=false when backupCurrent is false", () => {
    const queue = new RelayQueue(storePath);
    queue.enqueue({ project: "one", tool: "generic", command: ["a"], cwd: "/tmp" });
    queue.backup({ now: new Date("2026-07-18T09:00:01.000Z") });
    queue.close();

    const preview = previewRestoreStore({ storePath, backupCurrent: false });
    expect(preview.wouldBackUp).toBe(false);
    expect(preview.currentJobCount).toBe(1);
  });

  it("throws a clear error when no snapshot matches the selector", () => {
    const queue = new RelayQueue(storePath);
    queue.enqueue({ project: "one", tool: "generic", command: ["a"], cwd: "/tmp" });
    queue.close();
    expect(() => previewRestoreStore({ storePath, selector: "latest" })).toThrow(/No snapshot matches/);
  });
});

describe("showConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-show-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const entry = (result: ReturnType<typeof showConfig>, key: string) => {
    const found = result.entries.find((e) => e.key === key);
    if (!found) throw new Error(`no entry for ${key}`);
    return found;
  };

  it("reports all defaults when there is no config file and empty env", () => {
    const result = showConfig({ cwd: dir, env: { HOME: dir } });
    expect(result.path).toBeNull();
    expect(result.loadError).toBeUndefined();
    expect(result.entries.every((e) => e.source === "default")).toBe(true);
  });

  it("attributes file values and honors env precedence", () => {
    const path = join(dir, "agentrelay.config.json");
    writeFileSync(path, JSON.stringify({ store: "/from/file.json", retry: { maxAttempts: 9 } }));
    const result = showConfig({ path, env: { AGENTRELAY_MAX_ATTEMPTS: "3" } });
    expect(result.path).toBe(path);
    expect(entry(result, "AGENTRELAY_STORE")).toMatchObject({ source: "config-file", value: "/from/file.json" });
    // env beats the file for the same setting.
    expect(entry(result, "AGENTRELAY_MAX_ATTEMPTS")).toMatchObject({ source: "env", value: "3" });
  });

  it("does not throw on a broken config file — reports loadError and keeps going", () => {
    const path = join(dir, "agentrelay.config.json");
    writeFileSync(path, "{ not json");
    const result = showConfig({ path, env: {} });
    expect(result.loadError).toBeDefined();
    // Env/default resolution still produced (all defaults, since env is empty).
    expect(result.entries.every((e) => e.source === "default")).toBe(true);
  });

  it("renders a masked secret unless showSecrets is set", () => {
    const path = join(dir, "agentrelay.config.json");
    writeFileSync(path, JSON.stringify({ notify: { webhookAuth: "Bearer supersecrettoken" } }));
    const result = showConfig({ path, env: {} });
    const masked = renderEffectiveConfig(result, { color: false, showSecrets: false });
    expect(masked).not.toContain("Bearer supersecrettoken");
    expect(masked).toContain("oken"); // last 4 chars kept as a hint
    const revealed = renderEffectiveConfig(result, { color: false, showSecrets: true });
    expect(revealed).toContain("Bearer supersecrettoken");
  });

  it("renders default entries as (default)", () => {
    const result = showConfig({ cwd: dir, env: { HOME: dir } });
    const text = renderEffectiveConfig(result, { color: false });
    expect(text).toContain("AGENTRELAY_STORE");
    expect(text).toContain("(default)");
    expect(text).toContain("[default]");
  });
});

describe("getConfigValue", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-cfgget-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a file value and reports it as known", () => {
    const path = join(dir, "agentrelay.config.json");
    writeFileSync(path, JSON.stringify({ retry: { maxAttempts: 9 } }));
    const result = getConfigValue({ key: "retry.maxAttempts", path, env: {} });
    expect(result.known).toBe(true);
    expect(result.entry).toMatchObject({ value: "9", source: "config-file" });
    expect(configGetValue(result)).toBe("9");
  });

  it("honors env precedence over the file", () => {
    const path = join(dir, "agentrelay.config.json");
    writeFileSync(path, JSON.stringify({ store: "/from/file.json" }));
    const result = getConfigValue({ key: "store", path, env: { AGENTRELAY_STORE: "/from/env.json" } });
    expect(configGetValue(result)).toBe("/from/env.json");
    expect(result.entry?.source).toBe("env");
  });

  it("returns the empty string for a key on its default", () => {
    const result = getConfigValue({ key: "retry.factor", cwd: dir, env: { HOME: dir } });
    expect(result.known).toBe(true);
    expect(configGetValue(result)).toBe("");
  });

  it("flags an unknown key as not known (CLI exits 1)", () => {
    const result = getConfigValue({ key: "bogus.key", cwd: dir, env: { HOME: dir } });
    expect(result.known).toBe(false);
    expect(result.entry).toBeUndefined();
  });

  it("masks a secret unless showSecrets is set", () => {
    const path = join(dir, "agentrelay.config.json");
    writeFileSync(path, JSON.stringify({ notify: { webhookAuth: "Bearer supersecrettoken" } }));
    const result = getConfigValue({ key: "notify.webhookAuth", path, env: {} });
    expect(configGetValue(result)).not.toContain("Bearer supersecrettoken");
    expect(configGetValue(result)).toContain("oken"); // last 4 kept as a hint
    expect(configGetValue(result, true)).toBe("Bearer supersecrettoken");
  });

  it("renders --source and --json forms", () => {
    const path = join(dir, "agentrelay.config.json");
    writeFileSync(path, JSON.stringify({ retry: { maxAttempts: 9 } }));
    const result = getConfigValue({ key: "retry.maxAttempts", path, env: {} });
    expect(renderConfigGetWithSource(result)).toBe("9\t[config-file]");
    expect(JSON.parse(renderConfigGetJson(result))).toEqual({
      key: "retry.maxAttempts",
      value: "9",
      source: "config-file",
      secret: false,
    });
  });

  it("json/source render a default as null/(default)", () => {
    const result = getConfigValue({ key: "retry.factor", cwd: dir, env: { HOME: dir } });
    expect(renderConfigGetWithSource(result)).toBe("(default)\t[default]");
    expect(JSON.parse(renderConfigGetJson(result))).toMatchObject({ value: null, source: "default" });
  });

  it("json reveals a secret value in full (machine-readable escape hatch)", () => {
    const path = join(dir, "agentrelay.config.json");
    writeFileSync(path, JSON.stringify({ notify: { webhookAuth: "tok1234" } }));
    const result = getConfigValue({ key: "notify.webhookAuth", path, env: {} });
    expect(JSON.parse(renderConfigGetJson(result))).toMatchObject({ value: "tok1234", secret: true });
  });

  it("does not throw on a broken config file — surfaces loadError", () => {
    const path = join(dir, "agentrelay.config.json");
    writeFileSync(path, "{ not json");
    const result = getConfigValue({ key: "store", path, env: {} });
    expect(result.loadError).toBeDefined();
    // env/default resolution still succeeds (empty env → default).
    expect(result.known).toBe(true);
    expect(configGetValue(result)).toBe("");
  });
});

describe("isConfigDiagnosticInvocation", () => {
  const argv = (...rest: string[]) => ["node", "bin.js", ...rest];

  it("recognizes plain config validate/show/get", () => {
    expect(isConfigDiagnosticInvocation(argv("config", "validate"))).toBe(true);
    expect(isConfigDiagnosticInvocation(argv("config", "show"))).toBe(true);
    expect(isConfigDiagnosticInvocation(argv("config", "get"))).toBe(true);
  });

  it("recognizes them past a global --config <path> (the value is not the command)", () => {
    expect(isConfigDiagnosticInvocation(argv("--config", "/tmp/x.json", "config", "show"))).toBe(true);
    expect(isConfigDiagnosticInvocation(argv("--store", "/tmp/j.json", "config", "validate"))).toBe(true);
  });

  it("is false for other config subcommands and other commands", () => {
    expect(isConfigDiagnosticInvocation(argv("config", "init"))).toBe(false);
    expect(isConfigDiagnosticInvocation(argv("status"))).toBe(false);
    expect(isConfigDiagnosticInvocation(argv("config"))).toBe(false);
  });
});

describe("importStore", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-cli-import-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const record = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    project: "p",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T01:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...extra,
  });

  it("merges a JSON export file into the store", () => {
    const src = join(dir, "dump.json");
    writeFileSync(src, JSON.stringify([record("a"), record("b")]), "utf8");

    const result = importStore({ filePath: src, format: "json", storePath });
    expect(result).toMatchObject({ added: 2, updated: 0, dryRun: false });
    expect(result.parseErrors).toEqual([]);
    expect(
      listStatus(storePath)
        .map((j) => j.id)
        .sort()
    ).toEqual(["a", "b"]);
  });

  it("imports an NDJSON file and reports invalid lines without aborting", () => {
    const src = join(dir, "dump.ndjson");
    writeFileSync(src, [JSON.stringify(record("ok")), "{ broken", JSON.stringify({ id: "" })].join("\n"), "utf8");

    const result = importStore({ filePath: src, format: "ndjson", storePath });
    expect(result.added).toBe(1);
    expect(result.parseErrors).toHaveLength(2);
    expect(listStatus(storePath).map((j) => j.id)).toEqual(["ok"]);
  });

  it("dry-run reports the plan without writing the store", () => {
    const src = join(dir, "dump.json");
    writeFileSync(src, JSON.stringify([record("x")]), "utf8");

    const result = importStore({ filePath: src, format: "json", storePath, dryRun: true });
    expect(result).toMatchObject({ added: 1, dryRun: true });
    expect(existsSync(storePath)).toBe(false);
  });

  it("skips active jobs by default and imports them with includeActive", () => {
    const src = join(dir, "dump.json");
    writeFileSync(
      src,
      JSON.stringify([record("live", { status: "waiting_for_reset", resetAt: "2026-07-11T00:00:00.000Z" })]),
      "utf8"
    );

    const skipped = importStore({ filePath: src, format: "json", storePath });
    expect(skipped).toMatchObject({ added: 0, skippedActive: 1 });
    expect(listStatus(storePath)).toHaveLength(0);

    const included = importStore({ filePath: src, format: "json", storePath, includeActive: true });
    expect(included).toMatchObject({ added: 1, skippedActive: 0 });
    expect(listStatus(storePath)[0].id).toBe("live");
  });
});

describe("waitForJob", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-wait-cli-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(status: "queued" | "completed" | "failed" | "cancelled" = "queued"): string {
    const queue = new RelayQueue(storePath);
    const job = queue.enqueue({ project: "demo", tool: "claude-code", command: ["claude"], cwd: dir });
    if (status === "completed") queue.markCompleted(job.id, "done");
    else if (status === "failed") queue.markFailed(job.id, "boom");
    else if (status === "cancelled") queue.markCancelled(job.id);
    queue.close();
    return job.id;
  }

  it("returns immediately for an already-completed job (exit 0)", async () => {
    const id = seed("completed");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await waitForJob(id, { storePath, sleep });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("maps failed and cancelled to their exit codes", async () => {
    const failed = await waitForJob(seed("failed"), { storePath, sleep: vi.fn() });
    expect(failed.outcome).toBe("failed");
    expect(failed.exitCode).toBe(1);
    expect(failed.message).toMatch(/failed: boom/);

    const cancelled = await waitForJob(seed("cancelled"), { storePath, sleep: vi.fn() });
    expect(cancelled.outcome).toBe("cancelled");
    expect(cancelled.exitCode).toBe(2);
  });

  it("polls until the job settles, then returns the terminal outcome", async () => {
    const id = seed("queued");
    // Injected reader: pending twice, then completed.
    const snapshots: RelayJob[] = [];
    const q = new RelayQueue(storePath);
    const pending = q.getById(id) as RelayJob;
    q.close();
    snapshots.push(pending, pending, { ...pending, status: "completed" });
    let i = 0;
    const readJob = () => snapshots[Math.min(i++, snapshots.length - 1)];
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await waitForJob(id, { storePath, readJob, sleep, now: () => 0 });
    expect(result.outcome).toBe("completed");
    expect(result.exitCode).toBe(0);
    // Slept for the two pending polls before the terminal read.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("times out while the job is still pending (exit 124)", async () => {
    const id = seed("queued");
    let clock = 0;
    const now = () => clock;
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      clock += ms;
    });
    const result = await waitForJob(id, { storePath, intervalMs: 1000, timeoutMs: 2500, now, sleep });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("timeout");
    expect(result.exitCode).toBe(124);
    expect(result.message).toMatch(/timed out/);
  });

  it("reports missing when the job vanishes mid-wait (exit 5)", async () => {
    const id = seed("queued");
    // Reader returns null (job pruned away) after the first pending read.
    let i = 0;
    const q = new RelayQueue(storePath);
    const pending = q.getById(id) as RelayJob;
    q.close();
    const readJob = () => (i++ === 0 ? pending : null);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await waitForJob(id, { storePath, readJob, sleep, now: () => 0 });
    expect(result.outcome).toBe("missing");
    expect(result.exitCode).toBe(5);
  });

  it("returns ok:false for an unknown id (exit 1)", async () => {
    seed("queued");
    const result = await waitForJob("deadbeef", { storePath, sleep: vi.fn() });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/no job matches/);
  });
});
