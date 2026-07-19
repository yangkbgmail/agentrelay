import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_HEARTBEAT_FILENAME, type DiagnosticReport, RelayQueue } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readHeartbeatFacts, removeDaemonHeartbeat, runDoctor, writeDaemonHeartbeat } from "../src/commands.js";
import { renderDoctor, renderDoctorJson } from "../src/doctor.js";

const find = (report: DiagnosticReport, name: string) => report.checks.find((c) => c.name === name)!;

describe("runDoctor", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-doctor-test-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a healthy setup (store absent, no config, notify set)", () => {
    const report = runDoctor({
      storePath,
      cwd: dir,
      env: { AGENTRELAY_SLACK_WEBHOOK: "https://hooks.slack.com/x" },
      nodeVersion: "v22.5.0",
    });
    expect(report.ok).toBe(true);
    expect(find(report, "store").message).toContain("created on first run");
    expect(find(report, "config").level).toBe("ok");
    expect(find(report, "notify").level).toBe("ok");
  });

  it("counts jobs from a real store and flags active ones", () => {
    const queue = new RelayQueue(storePath);
    queue.enqueue({ project: "p", tool: "claude-code", command: ["claude"], cwd: dir }); // queued = active
    const done = queue.enqueue({ project: "p", tool: "claude-code", command: ["claude"], cwd: dir });
    queue.markCompleted(done.id);
    queue.close();

    const report = runDoctor({ storePath, cwd: dir, env: {}, nodeVersion: "v22.5.0" });
    const store = find(report, "store");
    expect(store.level).toBe("ok");
    expect(store.message).toContain("2 job(s)");
    expect(store.message).toContain("1 active");
  });

  it("errors when the store file is corrupt", () => {
    writeFileSync(storePath, "{ this is not valid json", "utf8");
    const report = runDoctor({ storePath, cwd: dir, env: {}, nodeVersion: "v22.5.0" });
    expect(find(report, "store").level).toBe("error");
    expect(report.ok).toBe(false);
  });

  it("errors when the config file is malformed", () => {
    const configPath = join(dir, "agentrelay.config.json");
    writeFileSync(configPath, "{ broken", "utf8");
    const report = runDoctor({ storePath, configPath, cwd: dir, env: {}, nodeVersion: "v22.5.0" });
    const config = find(report, "config");
    expect(config.level).toBe("error");
    expect(report.ok).toBe(false);
  });

  it("errors when the config file has semantic errors", () => {
    const configPath = join(dir, "agentrelay.config.json");
    writeFileSync(configPath, JSON.stringify({ retry: { factor: 0.5 } }), "utf8");
    const report = runDoctor({ storePath, configPath, cwd: dir, env: {}, nodeVersion: "v22.5.0" });
    expect(find(report, "config").level).toBe("error");
  });

  it("accepts a valid config file", () => {
    const configPath = join(dir, "agentrelay.config.json");
    writeFileSync(configPath, JSON.stringify({ retry: { maxAttempts: 3 } }), "utf8");
    const report = runDoctor({
      storePath,
      configPath,
      cwd: dir,
      env: { AGENTRELAY_WEBHOOK_URL: "https://x" },
      nodeVersion: "v22.5.0",
    });
    expect(find(report, "config").level).toBe("ok");
    expect(report.ok).toBe(true);
  });

  it("warns when no notification channel is set", () => {
    const report = runDoctor({ storePath, cwd: dir, env: {}, nodeVersion: "v22.5.0" });
    expect(find(report, "notify").level).toBe("warning");
    // notify warning alone still passes overall
    expect(report.ok).toBe(true);
  });

  it("reports adapters OK when there are no active jobs to resume", () => {
    const queue = new RelayQueue(storePath);
    const done = queue.enqueue({ project: "p", tool: "claude-code", command: ["nope-binary"], cwd: dir });
    queue.markCompleted(done.id); // terminal → never re-spawned
    queue.close();
    const report = runDoctor({ storePath, cwd: dir, env: {}, nodeVersion: "v22.5.0" });
    const adapters = find(report, "adapters");
    expect(adapters.level).toBe("ok");
    expect(adapters.message).toContain("no queued jobs");
  });

  it("errors when a queued job's binary is missing from PATH", () => {
    const queue = new RelayQueue(storePath);
    queue.enqueue({ project: "p", tool: "claude-code", command: ["definitely-not-installed-xyz"], cwd: dir });
    queue.close();
    const report = runDoctor({
      storePath,
      cwd: dir,
      env: { PATH: dir, AGENTRELAY_SLACK_WEBHOOK: "https://s" },
      nodeVersion: "v22.5.0",
    });
    const adapters = find(report, "adapters");
    expect(adapters.level).toBe("error");
    expect(adapters.message).toContain("definitely-not-installed-xyz");
    expect(report.ok).toBe(false);
  });

  it("reports adapters OK and resolves a real binary on PATH", () => {
    // Drop a fake executable into the temp dir and point PATH at it.
    const binName = "faketool";
    const binPath = join(dir, binName);
    writeFileSync(binPath, "#!/bin/sh\necho hi\n", "utf8");
    chmodSync(binPath, 0o755);

    const queue = new RelayQueue(storePath);
    queue.enqueue({ project: "p", tool: "generic", command: [binName, "--go"], cwd: dir });
    queue.close();

    const report = runDoctor({
      storePath,
      cwd: dir,
      env: { PATH: dir, AGENTRELAY_SLACK_WEBHOOK: "https://s" },
      nodeVersion: "v22.5.0",
    });
    const adapters = find(report, "adapters");
    expect(adapters.level).toBe("ok");
    expect(adapters.message).toContain(binName);
    expect(adapters.message).toContain(binPath);
    expect(report.ok).toBe(true);
  });

  it("reports store-writable OK for a writable store directory", () => {
    const report = runDoctor({ storePath, cwd: dir, env: {}, nodeVersion: "v22.5.0" });
    const writable = find(report, "store-writable");
    expect(writable.level).toBe("ok");
    expect(writable.message).toContain("is writable");
    expect(report.ok).toBe(true);
  });

  it("notes the store directory will be created when it doesn't exist yet", () => {
    // Point the store one level deeper than the temp dir, so its own dir is absent.
    const nestedStore = join(dir, "nested", "jobs.json");
    const report = runDoctor({ storePath: nestedStore, cwd: dir, env: {}, nodeVersion: "v22.5.0" });
    const writable = find(report, "store-writable");
    expect(writable.level).toBe("ok");
    expect(writable.message).toContain("will be created");
    expect(report.ok).toBe(true);
  });

  it("reports store-writable error (not a crash) when the store dir can't be created", () => {
    // Make the store's parent a regular file: mkdir/write into it fails with
    // ENOTDIR regardless of user, and RelayQueue's constructor would throw.
    // doctor must survive and report the diagnosis.
    const filePath = join(dir, "notadir");
    writeFileSync(filePath, "", "utf8");
    const badStore = join(filePath, "jobs.json");
    let report: DiagnosticReport | undefined;
    expect(() => {
      report = runDoctor({ storePath: badStore, cwd: dir, env: {}, nodeVersion: "v22.5.0" });
    }).not.toThrow();
    const writable = find(report!, "store-writable");
    expect(writable.level).toBe("error");
    expect(writable.message).toContain("not writable");
    expect(report!.ok).toBe(false);
  });

  // Root bypasses directory permission bits, so a chmod-based read-only probe
  // can't be exercised as root — skip there rather than assert a false result.
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it.skipIf(asRoot)("errors when the store directory is not writable", () => {
    const roStore = join(dir, "readonly", "jobs.json");
    mkdirSync(join(dir, "readonly"));
    chmodSync(join(dir, "readonly"), 0o500); // r-x: readable, not writable
    try {
      const report = runDoctor({
        storePath: roStore,
        cwd: dir,
        env: { AGENTRELAY_SLACK_WEBHOOK: "https://s" },
        nodeVersion: "v22.5.0",
      });
      const writable = find(report, "store-writable");
      expect(writable.level).toBe("error");
      expect(writable.message).toContain("not writable");
      expect(report.ok).toBe(false);
    } finally {
      // Restore write bit so afterEach can clean up.
      chmodSync(join(dir, "readonly"), 0o700);
    }
  });
});

describe("renderDoctor", () => {
  const report: DiagnosticReport = {
    ok: false,
    counts: { ok: 1, warning: 1, error: 1 },
    checks: [
      { name: "node-version", level: "ok", message: "Node 22.5 meets the 22.5+ requirement" },
      { name: "store", level: "error", message: "job store is corrupt", hint: "restore a snapshot" },
      { name: "notify", level: "warning", message: "no channel", hint: "set a webhook" },
    ],
  };

  it("renders every check name and message without color codes", () => {
    const out = renderDoctor(report, { color: false });
    expect(out).toContain("node-version");
    expect(out).toContain("job store is corrupt");
    expect(out).not.toContain("\x1b[");
  });

  it("shows hints for problems but not for ok checks", () => {
    const out = renderDoctor(report, { color: false });
    expect(out).toContain("↳ restore a snapshot");
    expect(out).toContain("↳ set a webhook");
    // the ok check has no hint
    expect(out).not.toContain("↳ Node");
  });

  it("summarizes the verdict as problems found when not ok", () => {
    const out = renderDoctor(report, { color: false });
    expect(out).toContain("problems found");
    expect(out).toContain("1 error");
  });

  it("emits ANSI codes when color is enabled", () => {
    const out = renderDoctor(report, { color: true });
    expect(out).toContain("\x1b[");
  });

  it("says all healthy when there are no warnings or errors", () => {
    const healthy: DiagnosticReport = {
      ok: true,
      counts: { ok: 4, warning: 0, error: 0 },
      checks: [{ name: "node-version", level: "ok", message: "fine" }],
    };
    expect(renderDoctor(healthy, { color: false })).toContain("all healthy");
  });

  it("says healthy with warnings when only warnings exist", () => {
    const warned: DiagnosticReport = {
      ok: true,
      counts: { ok: 3, warning: 1, error: 0 },
      checks: [{ name: "notify", level: "warning", message: "no channel", hint: "set one" }],
    };
    expect(renderDoctor(warned, { color: false })).toContain("healthy (with warnings)");
  });
});

describe("heartbeat helpers + doctor daemon check", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-hb-test-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Put one queued (active) job in the store so "waiting" logic engages. */
  function seedActiveJob(): void {
    const queue = new RelayQueue(storePath);
    queue.enqueue({ project: "p", tool: "claude-code", command: ["node", "--version"], cwd: dir });
    queue.close();
  }

  it("writes an atomic heartbeat next to the store and reads it back", () => {
    const now = Date.parse("2026-07-19T00:00:30.000Z");
    writeDaemonHeartbeat(storePath, {
      pid: 4242,
      mode: "daemon",
      startedAt: "2026-07-19T00:00:00.000Z",
      lastTickAt: "2026-07-19T00:00:30.000Z",
      pollIntervalMs: 30_000,
    });
    expect(existsSync(join(dir, DAEMON_HEARTBEAT_FILENAME))).toBe(true);

    const facts = readHeartbeatFacts(storePath, now);
    expect(facts.present).toBe(true);
    expect(facts.pid).toBe(4242);
    expect(facts.mode).toBe("daemon");
    expect(facts.ageMs).toBe(0);
    expect(facts.staleAfterMs).toBe(90_000);
  });

  it("reports absent facts when there is no heartbeat file", () => {
    expect(readHeartbeatFacts(storePath).present).toBe(false);
  });

  it("removeDaemonHeartbeat deletes the file (best-effort, no throw when missing)", () => {
    writeDaemonHeartbeat(storePath, {
      pid: 1,
      mode: "daemon",
      startedAt: "2026-07-19T00:00:00.000Z",
      lastTickAt: "2026-07-19T00:00:00.000Z",
      pollIntervalMs: 30_000,
    });
    removeDaemonHeartbeat(storePath);
    expect(existsSync(join(dir, DAEMON_HEARTBEAT_FILENAME))).toBe(false);
    // idempotent — removing again doesn't throw
    expect(() => removeDaemonHeartbeat(storePath)).not.toThrow();
  });

  it("doctor warns when a job is waiting but no resume loop is running", () => {
    seedActiveJob();
    const report = runDoctor({ storePath, cwd: dir, env: {}, nodeVersion: "v22.5.0" });
    const daemon = find(report, "daemon");
    expect(daemon.level).toBe("warning");
    expect(daemon.message).toContain("no resume loop is running");
  });

  it("doctor is OK when a fresh daemon heartbeat covers the waiting job", () => {
    seedActiveJob();
    const at = "2026-07-19T00:00:00.000Z";
    writeDaemonHeartbeat(storePath, {
      pid: 999,
      mode: "daemon",
      startedAt: at,
      lastTickAt: at,
      pollIntervalMs: 30_000,
    });
    const report = runDoctor({
      storePath,
      cwd: dir,
      env: {},
      nodeVersion: "v22.5.0",
      nowMs: Date.parse(at) + 5_000, // 5s after last tick → fresh
    });
    const daemon = find(report, "daemon");
    expect(daemon.level).toBe("ok");
    expect(daemon.message).toContain("pid 999");
  });

  it("doctor warns when the daemon heartbeat has gone stale", () => {
    seedActiveJob();
    const at = "2026-07-19T00:00:00.000Z";
    writeDaemonHeartbeat(storePath, {
      pid: 999,
      mode: "daemon",
      startedAt: at,
      lastTickAt: at,
      pollIntervalMs: 30_000,
    });
    const report = runDoctor({
      storePath,
      cwd: dir,
      env: {},
      nodeVersion: "v22.5.0",
      nowMs: Date.parse(at) + 10 * 60_000, // 10 min later, well past 90s stale window
    });
    const daemon = find(report, "daemon");
    expect(daemon.level).toBe("warning");
    expect(daemon.message).toContain("looks stopped");
  });

  it("doctor ignores a corrupt heartbeat file (reads as absent)", () => {
    writeFileSync(join(dir, DAEMON_HEARTBEAT_FILENAME), "{ not json", "utf8");
    expect(readHeartbeatFacts(storePath).present).toBe(false);
    // No active jobs + no usable heartbeat → daemon check is a benign OK.
    const report = runDoctor({ storePath, cwd: dir, env: {}, nodeVersion: "v22.5.0" });
    expect(find(report, "daemon").level).toBe("ok");
  });
});

describe("renderDoctorJson", () => {
  it("round-trips the report with a generatedAt stamp", () => {
    const report: DiagnosticReport = {
      ok: true,
      counts: { ok: 4, warning: 0, error: 0 },
      checks: [{ name: "node-version", level: "ok", message: "fine" }],
    };
    const parsed = JSON.parse(renderDoctorJson(report, "2026-07-19T00:00:00.000Z"));
    expect(parsed.generatedAt).toBe("2026-07-19T00:00:00.000Z");
    expect(parsed.ok).toBe(true);
    expect(parsed.checks[0].name).toBe("node-version");
  });
});
