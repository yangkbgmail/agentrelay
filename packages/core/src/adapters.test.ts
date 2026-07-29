import { describe, expect, it } from "vitest";
import {
  ADAPTERS,
  CODEX_CLI_ADAPTER,
  describeAdapter,
  describeAdapters,
  GENERIC_ADAPTER,
  summarizeAdapters,
} from "./adapters.js";
import { GENERIC_PATTERN_NAMES } from "./parser.js";

describe("describeAdapter", () => {
  it("serializes a plain, read-only view of one adapter", () => {
    const info = describeAdapter(CODEX_CLI_ADAPTER);
    expect(info.tool).toBe("codex-cli");
    expect(info.displayName).toBe("Codex CLI");
    expect(info.binaries).toEqual(["codex", "codex-cli"]);
    expect(info.extraPatterns).toEqual(["codex-relative-seconds"]);
    expect(info.isDefault).toBe(false);
  });

  it("marks the generic adapter as the default with no binaries", () => {
    const info = describeAdapter(GENERIC_ADAPTER);
    expect(info.tool).toBe("generic");
    expect(info.isDefault).toBe(true);
    expect(info.binaries).toEqual([]);
    expect(info.extraPatterns).toEqual([]);
  });

  it("copies the binaries array (mutating the result never touches the registry)", () => {
    const info = describeAdapter(CODEX_CLI_ADAPTER);
    info.binaries.push("hacked");
    info.extraPatterns.push("hacked");
    expect(CODEX_CLI_ADAPTER.binaries).toEqual(["codex", "codex-cli"]);
    expect(CODEX_CLI_ADAPTER.patterns.map((p) => p.name)).toEqual(["codex-relative-seconds"]);
  });
});

describe("describeAdapters", () => {
  it("describes every registered adapter, in registry order", () => {
    const infos = describeAdapters();
    expect(infos.map((a) => a.tool)).toEqual(Object.keys(ADAPTERS));
  });

  it("has exactly one default adapter", () => {
    const defaults = describeAdapters().filter((a) => a.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].tool).toBe("generic");
  });
});

describe("summarizeAdapters", () => {
  it("bundles the adapters with the shared generic pattern names", () => {
    const summary = summarizeAdapters();
    expect(summary.adapters.map((a) => a.tool)).toEqual(Object.keys(ADAPTERS));
    expect(summary.genericPatterns).toEqual([...GENERIC_PATTERN_NAMES]);
  });

  it("exposes a non-empty set of generic patterns including the ISO timestamp one", () => {
    const summary = summarizeAdapters();
    expect(summary.genericPatterns.length).toBeGreaterThan(0);
    expect(summary.genericPatterns).toContain("iso-timestamp");
  });

  it("returns a fresh copy of the generic pattern list each call", () => {
    const a = summarizeAdapters();
    a.genericPatterns.push("hacked");
    const b = summarizeAdapters();
    expect(b.genericPatterns).not.toContain("hacked");
  });
});
