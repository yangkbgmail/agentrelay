import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyStoreFile,
  corruptStamp,
  listCorruptBackups,
  listTmpFiles,
  selectCleanableFiles,
} from "../src/clean.js";
import { RelayQueue } from "../src/queue.js";

describe("clean pure helpers", () => {
  it("corruptStamp extracts the stamp only for this store's recovery copies", () => {
    expect(corruptStamp("jobs.json.corrupt-2026-07-18T00-00-00-000Z", "jobs.json")).toBe("2026-07-18T00-00-00-000Z");
    // A backup snapshot is not a corrupt copy.
    expect(corruptStamp("jobs.json.backup-2026-07-18T00-00-00-000Z", "jobs.json")).toBeNull();
    // Not this store.
    expect(corruptStamp("other.json.corrupt-2026-07-18T00-00-00-000Z", "jobs.json")).toBeNull();
    // The bare store file is not a corrupt copy.
    expect(corruptStamp("jobs.json", "jobs.json")).toBeNull();
    // Empty stamp (trailing infix only) is rejected.
    expect(corruptStamp("jobs.json.corrupt-", "jobs.json")).toBeNull();
  });

  it("classifyStoreFile distinguishes every store-directory file kind", () => {
    expect(classifyStoreFile("jobs.json", "jobs.json")).toBe("store");
    expect(classifyStoreFile("jobs.json.backup-2026-07-18T00-00-00-000Z", "jobs.json")).toBe("backup");
    expect(classifyStoreFile("jobs.json.corrupt-2026-07-18T00-00-00-000Z", "jobs.json")).toBe("corrupt");
    // Both flush and backup temp names share the .tmp- prefix.
    expect(classifyStoreFile("jobs.json.tmp-12345-1700000000000", "jobs.json")).toBe("tmp");
    expect(classifyStoreFile("jobs.json.tmp-backup-12345-1700000000000", "jobs.json")).toBe("tmp");
    // A bare `.tmp-` with no suffix, another store's files, and unrelated files are all "other".
    expect(classifyStoreFile("jobs.json.tmp-", "jobs.json")).toBe("other");
    expect(classifyStoreFile("other.json.corrupt-2026-07-18T00-00-00-000Z", "jobs.json")).toBe("other");
    expect(classifyStoreFile("daemon.json", "jobs.json")).toBe("other");
  });

  it("listCorruptBackups filters to this store and sorts newest first", () => {
    const names = [
      "jobs.json",
      "jobs.json.corrupt-2026-07-18T00-00-01-000Z",
      "jobs.json.corrupt-2026-07-18T00-00-03-000Z",
      "jobs.json.corrupt-2026-07-18T00-00-02-000Z",
      "jobs.json.backup-2026-07-18T00-00-09-000Z",
      "other.json.corrupt-2026-07-18T00-00-09-000Z",
    ];
    expect(listCorruptBackups(names, "jobs.json").map((e) => e.stamp)).toEqual([
      "2026-07-18T00-00-03-000Z",
      "2026-07-18T00-00-02-000Z",
      "2026-07-18T00-00-01-000Z",
    ]);
  });

  it("listTmpFiles returns only this store's temp files, sorted", () => {
    const names = [
      "jobs.json",
      "jobs.json.tmp-2-200",
      "jobs.json.tmp-1-100",
      "jobs.json.tmp-backup-3-300",
      "jobs.json.corrupt-2026-07-18T00-00-01-000Z",
      "other.json.tmp-9-900",
    ];
    expect(listTmpFiles(names, "jobs.json")).toEqual([
      "jobs.json.tmp-1-100",
      "jobs.json.tmp-2-200",
      "jobs.json.tmp-backup-3-300",
    ]);
  });

  it("selectCleanableFiles keeps newest N corrupt copies and excludes tmp by default", () => {
    const names = [
      "jobs.json",
      "jobs.json.backup-2026-07-18T00-00-09-000Z",
      "jobs.json.corrupt-2026-07-18T00-00-01-000Z",
      "jobs.json.corrupt-2026-07-18T00-00-02-000Z",
      "jobs.json.corrupt-2026-07-18T00-00-03-000Z",
      "jobs.json.tmp-1-100",
    ];
    // keepCorrupt: 0 removes all corrupt; tmp excluded unless opted in.
    const all = selectCleanableFiles(names, "jobs.json");
    expect(all.corrupt).toHaveLength(3);
    expect(all.tmp).toEqual([]);

    // keepCorrupt: 1 spares the newest recovery copy.
    const keep1 = selectCleanableFiles(names, "jobs.json", { keepCorrupt: 1 });
    expect(keep1.corrupt).toEqual([
      "jobs.json.corrupt-2026-07-18T00-00-02-000Z",
      "jobs.json.corrupt-2026-07-18T00-00-01-000Z",
    ]);

    // includeTmp adds temp files; never selects the store or its backups.
    const withTmp = selectCleanableFiles(names, "jobs.json", { keepCorrupt: 5, includeTmp: true });
    expect(withTmp.corrupt).toEqual([]);
    expect(withTmp.tmp).toEqual(["jobs.json.tmp-1-100"]);
  });
});

describe("RelayQueue.clean", () => {
  let dir: string;
  let queue: RelayQueue;
  let storeName: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-clean-"));
    const storePath = join(dir, "jobs.json");
    storeName = basename(storePath);
    queue = new RelayQueue(storePath);
    // Seed a store with one job plus leftover housekeeping files.
    queue.enqueue({ project: "p", tool: "claude-code", command: ["claude"], cwd: dir });
    writeFileSync(join(dir, `${storeName}.corrupt-2026-07-18T00-00-01-000Z`), "garbage", "utf8");
    writeFileSync(join(dir, `${storeName}.corrupt-2026-07-18T00-00-02-000Z`), "garbage", "utf8");
    writeFileSync(join(dir, `${storeName}.backup-2026-07-18T00-00-05-000Z`), "[]", "utf8");
    writeFileSync(join(dir, `${storeName}.tmp-999-123`), "half", "utf8");
  });

  afterEach(() => {
    queue.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("dry run reports candidates without deleting", () => {
    const result = queue.clean({ dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.corrupt).toHaveLength(2);
    expect(result.removed).toEqual([]);
    // All files still on disk.
    const names = readdirSync(dir);
    expect(names.filter((n) => n.includes(".corrupt-"))).toHaveLength(2);
  });

  it("removes corrupt copies but preserves the store and its backups", () => {
    const result = queue.clean();
    expect(result.removed).toHaveLength(2);
    expect(result.failed).toEqual([]);
    const names = readdirSync(dir);
    expect(names).toContain(storeName);
    expect(names.some((n) => n.includes(".backup-"))).toBe(true);
    expect(names.some((n) => n.includes(".corrupt-"))).toBe(false);
    // tmp not removed without opt-in.
    expect(names.some((n) => n.includes(".tmp-"))).toBe(true);
    // The store still has its job.
    expect(JSON.parse(readFileSync(join(dir, storeName), "utf8"))).toHaveLength(1);
  });

  it("keepCorrupt spares the newest recovery copy; includeTmp removes temp files", () => {
    const result = queue.clean({ keepCorrupt: 1, includeTmp: true });
    expect(result.keptCorrupt).toBe(1);
    const names = readdirSync(dir);
    const corrupt = names.filter((n) => n.includes(".corrupt-"));
    expect(corrupt).toEqual([`${storeName}.corrupt-2026-07-18T00-00-02-000Z`]);
    expect(names.some((n) => n.includes(".tmp-"))).toBe(false);
  });
});
