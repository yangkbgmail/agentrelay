import { describe, expect, it } from "vitest";
import { buildLocationReport, countStoreBackups, type LocationFacts } from "./locations.js";

const STORE = "/home/u/.agentrelay/jobs.json";

function facts(overrides: Partial<LocationFacts> = {}): LocationFacts {
  return {
    storePath: STORE,
    storeExists: true,
    configPath: null,
    configExists: false,
    heartbeatExists: false,
    storeDirFiles: ["jobs.json"],
    ...overrides,
  };
}

describe("countStoreBackups", () => {
  it("counts only this store's .backup-* snapshots", () => {
    const files = [
      "jobs.json",
      "jobs.json.backup-2026-07-18T13-38-10-351Z",
      "jobs.json.backup-2026-07-19T13-38-10-351Z",
      "jobs.json.corrupt-2026-07-18T13-38-10-351Z", // corruption copy, not a backup
      "jobs.json.tmp-abc", // in-flight write
      "other.json.backup-2026-07-18T13-38-10-351Z", // a different store's backup
    ];
    expect(countStoreBackups("jobs.json", files)).toBe(2);
  });

  it("returns 0 for a missing/unreadable directory or empty listing", () => {
    expect(countStoreBackups("jobs.json", null)).toBe(0);
    expect(countStoreBackups("jobs.json", [])).toBe(0);
  });
});

describe("buildLocationReport", () => {
  it("reports the store path and one entry per known location", () => {
    const report = buildLocationReport(facts());
    expect(report.storePath).toBe(STORE);
    expect(report.entries.map((e) => e.kind)).toEqual(["store", "store-dir", "config", "heartbeat", "backups"]);
  });

  it("derives the store directory, heartbeat, and backups-glob paths from the store path", () => {
    const report = buildLocationReport(facts());
    const byKind = Object.fromEntries(report.entries.map((e) => [e.kind, e]));
    expect(byKind["store-dir"].path).toBe("/home/u/.agentrelay");
    expect(byKind.heartbeat.path).toBe("/home/u/.agentrelay/daemon.json");
    expect(byKind.backups.path).toBe("/home/u/.agentrelay/jobs.json.backup-*");
  });

  it("marks the store absent with a 'created on first run' note when it does not exist", () => {
    const report = buildLocationReport(facts({ storeExists: false, storeDirFiles: null }));
    const byKind = Object.fromEntries(report.entries.map((e) => [e.kind, e]));
    expect(byKind.store.exists).toBe(false);
    expect(byKind.store.note).toMatch(/created on first run/);
    expect(byKind["store-dir"].exists).toBe(false);
    expect(byKind["store-dir"].note).toMatch(/created on first run/);
  });

  it("shows 'using built-in defaults' when no config file was resolved", () => {
    const report = buildLocationReport(facts({ configPath: null }));
    const config = report.entries.find((e) => e.kind === "config");
    expect(config?.path).toBeNull();
    expect(config?.exists).toBe(false);
    expect(config?.note).toMatch(/built-in defaults/);
  });

  it("reports a resolved config file that exists with no note", () => {
    const report = buildLocationReport(facts({ configPath: "/proj/agentrelay.config.json", configExists: true }));
    const config = report.entries.find((e) => e.kind === "config");
    expect(config?.path).toBe("/proj/agentrelay.config.json");
    expect(config?.exists).toBe(true);
    expect(config?.note).toBeUndefined();
  });

  it("flags a resolved-but-missing config (e.g. a bad --config/AGENTRELAY_CONFIG)", () => {
    const report = buildLocationReport(facts({ configPath: "/nope/agentrelay.config.json", configExists: false }));
    const config = report.entries.find((e) => e.kind === "config");
    expect(config?.exists).toBe(false);
    expect(config?.note).toMatch(/resolved but missing/);
  });

  it("counts backup snapshots and marks the entry present only when there is at least one", () => {
    const withBackups = buildLocationReport(
      facts({
        storeDirFiles: ["jobs.json", "jobs.json.backup-2026-07-18T13-38-10-351Z"],
      })
    );
    const backups = withBackups.entries.find((e) => e.kind === "backups");
    expect(backups?.exists).toBe(true);
    expect(backups?.note).toBe("1 snapshot");

    const none = buildLocationReport(facts({ storeDirFiles: ["jobs.json"] }));
    const noneBackups = none.entries.find((e) => e.kind === "backups");
    expect(noneBackups?.exists).toBe(false);
    expect(noneBackups?.note).toBe("0 snapshots");
  });

  it("marks the heartbeat present when it exists", () => {
    const report = buildLocationReport(facts({ heartbeatExists: true }));
    const hb = report.entries.find((e) => e.kind === "heartbeat");
    expect(hb?.exists).toBe(true);
    expect(hb?.note).toBeUndefined();
  });
});
