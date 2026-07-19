import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupFilePath, backupStamp, listBackups, resolveBackup, selectRotatableBackups } from "../src/backup.js";
import { RelayQueue } from "../src/queue.js";

describe("backup pure helpers", () => {
  it("backupFilePath is filesystem-safe and deterministic", () => {
    const at = new Date("2026-07-18T12:34:56.789Z");
    expect(backupFilePath("/a/b/jobs.json", at)).toBe("/a/b/jobs.json.backup-2026-07-18T12-34-56-789Z");
  });

  it("backupStamp extracts the stamp only for this store's backups", () => {
    expect(backupStamp("jobs.json.backup-2026-07-18T00-00-00-000Z", "jobs.json")).toBe("2026-07-18T00-00-00-000Z");
    // Not a backup of this store.
    expect(backupStamp("other.json.backup-2026-07-18T00-00-00-000Z", "jobs.json")).toBeNull();
    // A corrupt-recovery copy is not a backup.
    expect(backupStamp("jobs.json.corrupt-2026-07-18T00-00-00-000Z", "jobs.json")).toBeNull();
    // The bare store file is not a backup.
    expect(backupStamp("jobs.json", "jobs.json")).toBeNull();
    // Empty stamp (trailing infix only) is rejected.
    expect(backupStamp("jobs.json.backup-", "jobs.json")).toBeNull();
  });

  it("listBackups filters to this store and sorts newest first", () => {
    const names = [
      "jobs.json",
      "jobs.json.backup-2026-07-18T00-00-01-000Z",
      "jobs.json.backup-2026-07-18T00-00-03-000Z",
      "jobs.json.backup-2026-07-18T00-00-02-000Z",
      "jobs.json.corrupt-2026-07-18T00-00-00-000Z",
      "other.json.backup-2026-07-18T00-00-09-000Z",
    ];
    const ordered = listBackups(names, "jobs.json");
    expect(ordered.map((e) => e.stamp)).toEqual([
      "2026-07-18T00-00-03-000Z",
      "2026-07-18T00-00-02-000Z",
      "2026-07-18T00-00-01-000Z",
    ]);
  });

  it("selectRotatableBackups keeps the newest N and returns the rest", () => {
    const names = [
      "jobs.json.backup-2026-07-18T00-00-01-000Z",
      "jobs.json.backup-2026-07-18T00-00-02-000Z",
      "jobs.json.backup-2026-07-18T00-00-03-000Z",
      "jobs.json.backup-2026-07-18T00-00-04-000Z",
    ];
    // Keep 2 newest -> the 2 oldest are rotated out.
    expect(selectRotatableBackups(names, "jobs.json", 2)).toEqual([
      "jobs.json.backup-2026-07-18T00-00-02-000Z",
      "jobs.json.backup-2026-07-18T00-00-01-000Z",
    ]);
    // Keeping more than exist rotates nothing.
    expect(selectRotatableBackups(names, "jobs.json", 10)).toEqual([]);
    // keep 0 selects everything; non-integers floor.
    expect(selectRotatableBackups(names, "jobs.json", 0)).toHaveLength(4);
    expect(selectRotatableBackups(names, "jobs.json", 1.9)).toHaveLength(3);
  });

  it("resolveBackup matches latest / basename / stamp and rejects the rest", () => {
    const names = [
      "jobs.json",
      "jobs.json.backup-2026-07-18T00-00-01-000Z",
      "jobs.json.backup-2026-07-18T00-00-03-000Z",
      "jobs.json.backup-2026-07-18T00-00-02-000Z",
      "other.json.backup-2026-07-18T00-00-09-000Z",
    ];
    // "latest" (and the empty selector) -> newest snapshot.
    expect(resolveBackup(names, "jobs.json", "latest")?.stamp).toBe("2026-07-18T00-00-03-000Z");
    expect(resolveBackup(names, "jobs.json", "")?.stamp).toBe("2026-07-18T00-00-03-000Z");
    // Exact basename match.
    expect(resolveBackup(names, "jobs.json", "jobs.json.backup-2026-07-18T00-00-02-000Z")?.stamp).toBe(
      "2026-07-18T00-00-02-000Z"
    );
    // Stamp-only match.
    expect(resolveBackup(names, "jobs.json", "2026-07-18T00-00-01-000Z")?.name).toBe(
      "jobs.json.backup-2026-07-18T00-00-01-000Z"
    );
    // Unknown stamp / another store's snapshot / no snapshots at all.
    expect(resolveBackup(names, "jobs.json", "2099-01-01T00-00-00-000Z")).toBeNull();
    expect(resolveBackup(names, "jobs.json", "other.json.backup-2026-07-18T00-00-09-000Z")).toBeNull();
    expect(resolveBackup(["jobs.json"], "jobs.json", "latest")).toBeNull();
  });
});

describe("RelayQueue.backup", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-backup-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a valid snapshot of the current store", () => {
    const storePath = join(dir, "jobs.json");
    const queue = new RelayQueue(storePath);
    const job = queue.enqueue({ project: "demo", tool: "claude-code", command: ["claude"], cwd: "/tmp" });

    const result = queue.backup({ now: new Date("2026-07-18T09:00:00.000Z") });
    queue.close();

    expect(result.path).toBe(`${storePath}.backup-2026-07-18T09-00-00-000Z`);
    expect(result.jobCount).toBe(1);
    expect(result.rotated).toEqual([]);
    const snapshot = JSON.parse(readFileSync(result.path, "utf8"));
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].id).toBe(job.id);
  });

  it("snapshots an empty store as a valid []", () => {
    const storePath = join(dir, "jobs.json");
    const queue = new RelayQueue(storePath);
    const result = queue.backup();
    queue.close();
    expect(result.jobCount).toBe(0);
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toEqual([]);
  });

  it("rotates old snapshots, keeping the newest keepLast (and always the new one)", () => {
    const storePath = join(dir, "jobs.json");
    const queue = new RelayQueue(storePath);
    queue.enqueue({ project: "demo", tool: "claude-code", command: ["claude"], cwd: "/tmp" });

    // Four snapshots at distinct times.
    queue.backup({ keepLast: 3, now: new Date("2026-07-18T09:00:01.000Z") });
    queue.backup({ keepLast: 3, now: new Date("2026-07-18T09:00:02.000Z") });
    queue.backup({ keepLast: 3, now: new Date("2026-07-18T09:00:03.000Z") });
    const last = queue.backup({ keepLast: 3, now: new Date("2026-07-18T09:00:04.000Z") });
    queue.close();

    // Keeping 3 after the 4th -> exactly the oldest was rotated out.
    expect(last.rotated).toHaveLength(1);
    expect(basename(last.rotated[0])).toBe("jobs.json.backup-2026-07-18T09-00-01-000Z");
    const remaining = readdirSync(dir)
      .filter((f) => f.includes(".backup-"))
      .sort();
    expect(remaining).toEqual([
      "jobs.json.backup-2026-07-18T09-00-02-000Z",
      "jobs.json.backup-2026-07-18T09-00-03-000Z",
      "jobs.json.backup-2026-07-18T09-00-04-000Z",
    ]);
  });

  it("never rotates away the just-written snapshot at keepLast 0", () => {
    const storePath = join(dir, "jobs.json");
    const queue = new RelayQueue(storePath);
    queue.backup({ keepLast: 0, now: new Date("2026-07-18T09:00:01.000Z") });
    const second = queue.backup({ keepLast: 0, now: new Date("2026-07-18T09:00:02.000Z") });
    queue.close();
    // The earlier snapshot is gone, but the one we just made survives.
    const remaining = readdirSync(dir).filter((f) => f.includes(".backup-"));
    expect(remaining).toEqual(["jobs.json.backup-2026-07-18T09-00-02-000Z"]);
    expect(second.rotated.some((p) => p.endsWith("09-00-01-000Z"))).toBe(true);
  });

  it("does not touch a corrupt-recovery copy when rotating", () => {
    const storePath = join(dir, "jobs.json");
    // A stale corrupt copy sitting next to the store.
    const corrupt = `${storePath}.corrupt-2026-07-18T00-00-00-000Z`;
    writeFileSync(corrupt, "garbage", "utf8");

    const queue = new RelayQueue(storePath);
    queue.backup({ keepLast: 0, now: new Date("2026-07-18T09:00:01.000Z") });
    queue.close();

    // The corrupt copy is left alone even though keepLast 0 rotates aggressively.
    expect(readdirSync(dir)).toContain("jobs.json.corrupt-2026-07-18T00-00-00-000Z");
    expect(readFileSync(corrupt, "utf8")).toBe("garbage");
  });
});

describe("RelayQueue.restore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-restore-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("replaces the store with a snapshot's contents and backs up the previous store", () => {
    const storePath = join(dir, "jobs.json");
    const queue = new RelayQueue(storePath);
    const original = queue.enqueue({ project: "orig", tool: "claude-code", command: ["claude"], cwd: "/tmp" });
    const snapshot = queue.backup({ now: new Date("2026-07-18T09:00:00.000Z") });

    // Mutate the store after the snapshot: add a second job, cancel the first.
    const second = queue.enqueue({ project: "later", tool: "codex-cli", command: ["codex"], cwd: "/tmp" });
    queue.markCancelled(original.id);
    expect(queue.listAll()).toHaveLength(2);

    const result = queue.restore({ from: snapshot.path, now: new Date("2026-07-18T10:00:00.000Z") });
    queue.close();

    // Store is back to the single original job.
    expect(result.jobCount).toBe(1);
    expect(result.from).toBe(snapshot.path);
    const restored = JSON.parse(readFileSync(storePath, "utf8"));
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe(original.id);
    expect(restored[0].status).toBe("queued");
    expect(restored.some((j: { id: string }) => j.id === second.id)).toBe(false);

    // The pre-restore state was snapshotted so the restore is itself undoable.
    expect(result.backedUpTo).toBe(`${storePath}.backup-2026-07-18T10-00-00-000Z`);
    const safety = JSON.parse(readFileSync(result.backedUpTo as string, "utf8"));
    expect(safety).toHaveLength(2);
  });

  it("skips the safety backup when backupCurrent is false", () => {
    const storePath = join(dir, "jobs.json");
    const queue = new RelayQueue(storePath);
    queue.enqueue({ project: "a", tool: "generic", command: ["x"], cwd: "/tmp" });
    const snapshot = queue.backup({ now: new Date("2026-07-18T09:00:00.000Z") });
    queue.enqueue({ project: "b", tool: "generic", command: ["y"], cwd: "/tmp" });

    const result = queue.restore({ from: snapshot.path, backupCurrent: false });
    queue.close();

    expect(result.backedUpTo).toBeNull();
    // Only the snapshot backup exists; no safety backup was written.
    const backups = readdirSync(dir).filter((f) => f.includes(".backup-"));
    expect(backups).toEqual(["jobs.json.backup-2026-07-18T09-00-00-000Z"]);
  });

  it("throws without touching the live store when the snapshot is not a jobs array", () => {
    const storePath = join(dir, "jobs.json");
    const queue = new RelayQueue(storePath);
    const job = queue.enqueue({ project: "keep", tool: "generic", command: ["x"], cwd: "/tmp" });

    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ not: "an array" }), "utf8");
    expect(() => queue.restore({ from: bad })).toThrow(/not a JSON array/);

    // Live store is untouched: the original job is still there.
    queue.close();
    const live = JSON.parse(readFileSync(storePath, "utf8"));
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(job.id);
    // No safety backup was written for the failed restore.
    expect(readdirSync(dir).filter((f) => f.includes(".backup-"))).toEqual([]);
  });
});
