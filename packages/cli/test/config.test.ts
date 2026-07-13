import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPathFromArgv, initConfigFile, resolveConfigInitPath } from "../src/config.js";

describe("configPathFromArgv", () => {
  it("reads --config <path> and --config=<path>", () => {
    expect(configPathFromArgv(["node", "cli", "--config", "/a/b.json"])).toBe("/a/b.json");
    expect(configPathFromArgv(["node", "cli", "--config=/c/d.json"])).toBe("/c/d.json");
  });

  it("returns undefined when the flag is absent", () => {
    expect(configPathFromArgv(["node", "cli", "status"])).toBeUndefined();
  });
});

describe("resolveConfigInitPath", () => {
  it("defaults to <cwd>/agentrelay.config.json", () => {
    expect(resolveConfigInitPath({ cwd: "/work" })).toBe("/work/agentrelay.config.json");
  });

  it("uses an absolute explicit path verbatim, resolves a relative one against cwd", () => {
    expect(resolveConfigInitPath({ path: "/abs/custom.json", cwd: "/work" })).toBe("/abs/custom.json");
    expect(resolveConfigInitPath({ path: "sub/custom.json", cwd: "/work" })).toBe("/work/sub/custom.json");
  });
});

describe("initConfigFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-init-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a valid, parseable sample config to the default path", () => {
    const result = initConfigFile({ cwd: dir });
    expect(result.ok).toBe(true);
    expect(result.written).toBe(true);
    const target = join(dir, "agentrelay.config.json");
    expect(result.path).toBe(target);
    expect(existsSync(target)).toBe(true);
    // The generated file must round-trip through the core validator.
    const parsed = parseConfig(JSON.parse(readFileSync(target, "utf8")));
    expect(parsed.retry?.maxAttempts).toBe(5);
    expect(parsed.autoPrune?.enabled).toBe(false);
  });

  it("bakes the provided store path into the file", () => {
    initConfigFile({ cwd: dir, store: "/custom/jobs.json" });
    const parsed = parseConfig(JSON.parse(readFileSync(join(dir, "agentrelay.config.json"), "utf8")));
    expect(parsed.store).toBe("/custom/jobs.json");
  });

  it("refuses to overwrite an existing file without --force", () => {
    const target = join(dir, "agentrelay.config.json");
    writeFileSync(target, '{"store":"/keep/me.json"}');
    const result = initConfigFile({ cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.written).toBe(false);
    expect(result.message).toMatch(/already exists/);
    // Untouched.
    expect(readFileSync(target, "utf8")).toBe('{"store":"/keep/me.json"}');
  });

  it("overwrites when force is set", () => {
    const target = join(dir, "agentrelay.config.json");
    writeFileSync(target, '{"store":"/old.json"}');
    const result = initConfigFile({ cwd: dir, force: true });
    expect(result.ok).toBe(true);
    expect(result.written).toBe(true);
    expect(parseConfig(JSON.parse(readFileSync(target, "utf8"))).retry?.maxAttempts).toBe(5);
  });

  it("creates missing parent directories for a nested explicit path", () => {
    const nested = join(dir, "deep", "nested", "cfg.json");
    const result = initConfigFile({ path: nested, cwd: dir });
    expect(result.ok).toBe(true);
    expect(existsSync(nested)).toBe(true);
  });
});
