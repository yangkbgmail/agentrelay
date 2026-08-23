import { describe, expect, it } from "vitest";
import { backupFilePath } from "./backup.js";
import { classifySidecar, isSidecarKind, SIDECAR_KINDS, type SidecarFile, selectCleanableSidecars } from "./clean.js";
import { corruptBackupPath } from "./queue.js";

const STORE = "jobs.json";

describe("classifySidecar", () => {
  it("recognizes corrupt recovery copies", () => {
    expect(classifySidecar("jobs.json.corrupt-2026-08-23T04-00-00-000Z", STORE)).toBe("corrupt");
  });

  it("recognizes atomic-write temp files (plain and backup temp)", () => {
    expect(classifySidecar("jobs.json.tmp-12345-1750000000000", STORE)).toBe("tmp");
    expect(classifySidecar("jobs.json.tmp-backup-12345-1750000000000", STORE)).toBe("tmp");
  });

  it("never classifies the store file or its .backup- snapshots", () => {
    expect(classifySidecar("jobs.json", STORE)).toBeNull();
    expect(classifySidecar("jobs.json.backup-2026-08-23T04-00-00-000Z", STORE)).toBeNull();
  });

  it("requires a stamp after the infix", () => {
    expect(classifySidecar("jobs.json.corrupt-", STORE)).toBeNull();
    expect(classifySidecar("jobs.json.tmp-", STORE)).toBeNull();
  });

  it("ignores files for a different store name", () => {
    expect(classifySidecar("other.json.corrupt-x", STORE)).toBeNull();
    expect(classifySidecar("unrelated.txt", STORE)).toBeNull();
  });

  it("stays in sync with the paths queue.ts actually writes", () => {
    // Drift guard: if corruptBackupPath's infix ever changes, this breaks.
    const corrupt = corruptBackupPath("/data/jobs.json", new Date("2026-08-23T04:00:00.000Z"));
    expect(classifySidecar(corrupt.split("/").pop() as string, STORE)).toBe("corrupt");
    // And a real backup path must NOT be swept as a sidecar.
    const backup = backupFilePath("/data/jobs.json", new Date("2026-08-23T04:00:00.000Z"));
    expect(classifySidecar(backup.split("/").pop() as string, STORE)).toBeNull();
  });
});

describe("isSidecarKind", () => {
  it("accepts known kinds and rejects others", () => {
    expect(SIDECAR_KINDS.every(isSidecarKind)).toBe(true);
    expect(isSidecarKind("backup")).toBe(false);
    expect(isSidecarKind("")).toBe(false);
  });
});

const NOW = Date.parse("2026-08-23T12:00:00.000Z");
const HOUR = 3_600_000;

function file(overrides: Partial<SidecarFile> = {}): SidecarFile {
  return {
    name: "jobs.json.corrupt-x",
    kind: "corrupt",
    mtimeMs: NOW - HOUR,
    sizeBytes: 100,
    ...overrides,
  };
}

describe("selectCleanableSidecars", () => {
  it("selects all sidecar kinds by default", () => {
    const files = [file({ name: "a", kind: "corrupt" }), file({ name: "b", kind: "tmp" })];
    expect(
      selectCleanableSidecars(files, { nowMs: NOW })
        .map((f) => f.name)
        .sort()
    ).toEqual(["a", "b"]);
  });

  it("restricts to the requested kinds", () => {
    const files = [file({ name: "a", kind: "corrupt" }), file({ name: "b", kind: "tmp" })];
    const only = selectCleanableSidecars(files, { nowMs: NOW, kinds: ["tmp"] });
    expect(only.map((f) => f.name)).toEqual(["b"]);
  });

  it("selects nothing for an empty kinds list", () => {
    const files = [file({ name: "a" })];
    expect(selectCleanableSidecars(files, { nowMs: NOW, kinds: [] })).toEqual([]);
  });

  it("applies the age filter by mtime", () => {
    const files = [
      file({ name: "old", mtimeMs: NOW - 3 * HOUR }),
      file({ name: "recent", mtimeMs: NOW - 30 * 60_000 }),
    ];
    const stale = selectCleanableSidecars(files, { nowMs: NOW, olderThanMs: HOUR });
    expect(stale.map((f) => f.name)).toEqual(["old"]);
  });

  it("disables the age filter for null / non-positive olderThanMs", () => {
    const files = [file({ name: "old", mtimeMs: 0 }), file({ name: "new", mtimeMs: NOW })];
    expect(selectCleanableSidecars(files, { nowMs: NOW, olderThanMs: null }).length).toBe(2);
    expect(selectCleanableSidecars(files, { nowMs: NOW, olderThanMs: 0 }).length).toBe(2);
    expect(selectCleanableSidecars(files, { nowMs: NOW, olderThanMs: -5 }).length).toBe(2);
  });

  it("returns oldest-first with a stable name tiebreak", () => {
    const files = [
      file({ name: "z", mtimeMs: NOW - HOUR }),
      file({ name: "a", mtimeMs: NOW - HOUR }),
      file({ name: "older", mtimeMs: NOW - 5 * HOUR }),
    ];
    expect(selectCleanableSidecars(files, { nowMs: NOW }).map((f) => f.name)).toEqual(["older", "a", "z"]);
  });
});
