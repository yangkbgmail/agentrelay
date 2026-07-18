import { describe, expect, it } from "vitest";
import { backupPathFor, backupStamp, DEFAULT_BACKUP_KEEP, isBackupFile, selectRotatedBackups } from "../src/backup.js";

describe("backupStamp", () => {
  it("produces a filesystem-safe, chronologically-sortable stamp", () => {
    const stamp = backupStamp(new Date("2026-07-18T13:38:10.351Z"));
    expect(stamp).toBe("2026-07-18T13-38-10-351Z");
    // No characters that would be awkward in a filename.
    expect(stamp).not.toMatch(/[:.]/);
  });

  it("sorts lexicographically in the same order as chronologically", () => {
    const earlier = backupStamp(new Date("2026-07-18T13:00:00.000Z"));
    const later = backupStamp(new Date("2026-07-18T13:00:00.001Z"));
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });
});

describe("backupPathFor", () => {
  it("names the backup as a sibling of the store with a .bak- infix", () => {
    const path = backupPathFor("/x/.agentrelay/jobs.json", new Date("2026-07-18T13:38:10.351Z"));
    expect(path).toBe("/x/.agentrelay/jobs.json.bak-2026-07-18T13-38-10-351Z");
  });
});

describe("isBackupFile", () => {
  it("recognizes only backups of the given store basename with a non-empty stamp", () => {
    expect(isBackupFile("jobs.json.bak-2026-07-18T13-38-10-351Z", "jobs.json")).toBe(true);
    // No stamp after the infix.
    expect(isBackupFile("jobs.json.bak-", "jobs.json")).toBe(false);
    // Different store.
    expect(isBackupFile("other.json.bak-2026", "jobs.json")).toBe(false);
    // The store itself and its other sidecars are not backups.
    expect(isBackupFile("jobs.json", "jobs.json")).toBe(false);
    expect(isBackupFile("jobs.json.corrupt-2026", "jobs.json")).toBe(false);
    expect(isBackupFile("jobs.json.tmp-123-456", "jobs.json")).toBe(false);
  });
});

describe("selectRotatedBackups", () => {
  const base = "jobs.json";
  const mk = (stamp: string) => `${base}.bak-${stamp}`;
  const b1 = mk("2026-07-18T10-00-00-000Z");
  const b2 = mk("2026-07-18T11-00-00-000Z");
  const b3 = mk("2026-07-18T12-00-00-000Z");

  it("returns the oldest backups beyond keepLast, ignoring non-backup entries", () => {
    const entries = ["jobs.json", "jobs.json.corrupt-x", b3, b1, b2];
    expect(selectRotatedBackups(entries, base, 2)).toEqual([b1]);
    expect(selectRotatedBackups(entries, base, 1)).toEqual([b1, b2]);
  });

  it("keeps everything when there are keepLast or fewer backups", () => {
    expect(selectRotatedBackups([b1, b2], base, 2)).toEqual([]);
    expect(selectRotatedBackups([b1], base, 5)).toEqual([]);
    expect(selectRotatedBackups([], base, 3)).toEqual([]);
  });

  it("selects every backup when keepLast <= 0 (keep none)", () => {
    expect(selectRotatedBackups([b2, b1, b3], base, 0)).toEqual([b1, b2, b3]);
    expect(selectRotatedBackups([b2, b1], base, -1)).toEqual([b1, b2]);
  });

  it("exposes a sane default retention count", () => {
    expect(DEFAULT_BACKUP_KEEP).toBeGreaterThan(0);
  });
});
