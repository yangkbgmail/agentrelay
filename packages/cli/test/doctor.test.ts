import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiagnosticReport } from "@agentrelay/core";
import { RelayQueue } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/commands.js";
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
