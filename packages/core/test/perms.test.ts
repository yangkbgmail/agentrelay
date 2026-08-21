import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFileMode, DEFAULT_STORE_FILE_MODE, parseFileMode, storeFileModeFromEnv } from "../src/perms.js";
import { RelayQueue } from "../src/queue.js";

/** POSIX-only: on Windows chmod can't set arbitrary permission triples. */
const posix = process.platform !== "win32";
/** Lower 9 permission bits (owner/group/other rwx) of a file's mode. */
const permBits = (path: string) => statSync(path).mode & 0o777;

describe("parseFileMode", () => {
  it("parses octal spellings people type", () => {
    expect(parseFileMode("600")).toBe(0o600);
    expect(parseFileMode("0600")).toBe(0o600);
    expect(parseFileMode("0o600")).toBe(0o600);
    expect(parseFileMode("0O640")).toBe(0o640);
    expect(parseFileMode("644")).toBe(0o644);
    expect(parseFileMode(" 600 ")).toBe(0o600);
  });

  it("always interprets the value as octal, never decimal", () => {
    // "100" octal is 64 decimal — a decimal reading (100) would be wrong.
    expect(parseFileMode("100")).toBe(0o100);
    expect(parseFileMode("777")).toBe(0o777);
  });

  it("rejects non-octal digits, out-of-range, and junk", () => {
    expect(parseFileMode("")).toBeNull();
    expect(parseFileMode("   ")).toBeNull();
    expect(parseFileMode("8")).toBeNull(); // 8 isn't an octal digit
    expect(parseFileMode("9")).toBeNull();
    expect(parseFileMode("1000")).toBeNull(); // > 0o777
    expect(parseFileMode("rw-")).toBeNull();
    expect(parseFileMode("0x180")).toBeNull();
  });
});

describe("storeFileModeFromEnv", () => {
  it("defaults to 0600 when unset or empty", () => {
    expect(storeFileModeFromEnv({})).toBe(DEFAULT_STORE_FILE_MODE);
    expect(storeFileModeFromEnv({ AGENTRELAY_STORE_MODE: "" })).toBe(DEFAULT_STORE_FILE_MODE);
    expect(storeFileModeFromEnv({ AGENTRELAY_STORE_MODE: "   " })).toBe(DEFAULT_STORE_FILE_MODE);
  });

  it("opts out (null) on off/none/inherit/default, case-insensitively", () => {
    for (const raw of ["off", "none", "inherit", "default", "OFF", "None", "Inherit"]) {
      expect(storeFileModeFromEnv({ AGENTRELAY_STORE_MODE: raw })).toBeNull();
    }
  });

  it("honors a valid octal override", () => {
    expect(storeFileModeFromEnv({ AGENTRELAY_STORE_MODE: "640" })).toBe(0o640);
    expect(storeFileModeFromEnv({ AGENTRELAY_STORE_MODE: "0600" })).toBe(0o600);
  });

  it("falls back to the secure default (never loosens) on a malformed value", () => {
    // A typo must not silently drop the hardening or read as 'no chmod'.
    expect(storeFileModeFromEnv({ AGENTRELAY_STORE_MODE: "nonsense" })).toBe(DEFAULT_STORE_FILE_MODE);
    expect(storeFileModeFromEnv({ AGENTRELAY_STORE_MODE: "999" })).toBe(DEFAULT_STORE_FILE_MODE);
    expect(storeFileModeFromEnv({ AGENTRELAY_STORE_MODE: "1000" })).toBe(DEFAULT_STORE_FILE_MODE);
  });
});

describe("applyFileMode", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-perms-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op for a null mode", () => {
    const f = join(dir, "f.json");
    writeFileSync(f, "[]", { mode: 0o644 });
    if (posix) chmodSync(f, 0o644);
    expect(applyFileMode(f, null)).toBe(false);
    if (posix) expect(permBits(f)).toBe(0o644);
  });

  it("swallows errors on a missing path rather than throwing", () => {
    expect(applyFileMode(join(dir, "does-not-exist.json"), 0o600)).toBe(false);
  });

  it.runIf(posix)("applies the requested mode", () => {
    const f = join(dir, "f.json");
    writeFileSync(f, "[]");
    chmodSync(f, 0o644);
    expect(applyFileMode(f, 0o600)).toBe(true);
    expect(permBits(f)).toBe(0o600);
  });
});

describe("RelayQueue store-file permissions", () => {
  let dir: string;
  let storePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-store-perms-"));
    storePath = join(dir, "jobs.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(posix)("writes the store owner-only (0600) by default", () => {
    const q = new RelayQueue(storePath);
    q.enqueue({ project: "p", tool: "generic", command: ["echo", "--secret", "sk-abc"], cwd: dir });
    expect(permBits(storePath)).toBe(0o600);
  });

  it.runIf(posix)("tightens an already-loose store on the next write", () => {
    // Seed a world-readable store as if written before hardening existed.
    writeFileSync(storePath, "[]", { mode: 0o644 });
    chmodSync(storePath, 0o644);
    expect(permBits(storePath)).toBe(0o644);

    const q = new RelayQueue(storePath);
    q.enqueue({ project: "p", tool: "generic", command: ["echo"], cwd: dir });
    expect(permBits(storePath)).toBe(0o600);
  });

  it.runIf(posix)("applies the same mode to backup snapshots", () => {
    const q = new RelayQueue(storePath);
    q.enqueue({ project: "p", tool: "generic", command: ["echo"], cwd: dir });
    const { path } = q.backup();
    expect(permBits(path)).toBe(0o600);
  });

  it.runIf(posix)("honors a custom fileMode", () => {
    const q = new RelayQueue(storePath, { fileMode: 0o640 });
    q.enqueue({ project: "p", tool: "generic", command: ["echo"], cwd: dir });
    expect(permBits(storePath)).toBe(0o640);
  });

  it.runIf(posix)("opts out of hardening when fileMode is null", () => {
    // With chmod disabled the store keeps the umask-derived mode. To assert this
    // deterministically (independent of the runner's umask) we pin the umask to
    // 022 for the write, so the new file lands at 0644 — group/other readable,
    // proving the 0600 hardening was skipped. Skip if umask isn't settable
    // (e.g. running inside a worker thread).
    let prevUmask: number | undefined;
    try {
      prevUmask = process.umask(0o022);
    } catch {
      return;
    }
    try {
      const q = new RelayQueue(storePath, { fileMode: null });
      q.enqueue({ project: "p", tool: "generic", command: ["echo"], cwd: dir });
      expect(permBits(storePath)).toBe(0o644);
    } finally {
      process.umask(prevUmask);
    }
  });
});
