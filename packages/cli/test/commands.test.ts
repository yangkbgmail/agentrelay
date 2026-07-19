import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { NotifyPayload } from "@agentrelay/core";
import { parseConfig, RelayQueue, sampleConfigJson } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backupStore,
  cancelJob,
  initConfig,
  listStatus,
  listStoreBackups,
  previewRestoreStore,
  pruneJobs,
  restoreStore,
  retryJob,
  runCommand,
  showConfig,
  showJob,
  validateConfigFile,
} from "../src/commands.js";
import { isConfigDiagnosticInvocation, renderEffectiveConfig } from "../src/config.js";

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

describe("isConfigDiagnosticInvocation", () => {
  const argv = (...rest: string[]) => ["node", "bin.js", ...rest];

  it("recognizes plain config validate/show", () => {
    expect(isConfigDiagnosticInvocation(argv("config", "validate"))).toBe(true);
    expect(isConfigDiagnosticInvocation(argv("config", "show"))).toBe(true);
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
