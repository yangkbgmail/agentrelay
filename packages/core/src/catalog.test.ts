import { describe, expect, it } from "vitest";
import { resolveAdapter } from "./adapters.js";
import { getPatternCatalog, knownAdapterPatternNames, PATTERN_CATALOG, type PatternDoc } from "./catalog.js";
import { GENERIC_PATTERN_NAMES, parseRateLimitMessage } from "./parser.js";

// A fixed "now" so relative examples ("in 4h 32m") resolve deterministically.
const NOW = new Date("2026-07-30T00:00:00.000Z");

/** Parse an example the way the catalog's tool scope implies: generic-only for
 *  generic docs, or through the tool adapter (its patterns tried first) for
 *  adapter docs. */
function detect(doc: PatternDoc) {
  if (doc.scope === "adapter") {
    return resolveAdapter({ tool: doc.tool }).detectRateLimit(doc.example, { now: NOW });
  }
  return parseRateLimitMessage(doc.example, { now: NOW });
}

describe("PATTERN_CATALOG", () => {
  it("every example actually parses to the pattern it documents", () => {
    for (const doc of PATTERN_CATALOG) {
      const info = detect(doc);
      expect(info, `example for ${doc.name} should match`).not.toBeNull();
      expect(info?.pattern, `example for ${doc.name} matched the wrong pattern`).toBe(doc.name);
    }
  });

  it("has a non-empty description and example for every entry", () => {
    for (const doc of PATTERN_CATALOG) {
      expect(doc.description.trim().length, `${doc.name} needs a description`).toBeGreaterThan(0);
      expect(doc.example.trim().length, `${doc.name} needs an example`).toBeGreaterThan(0);
    }
  });

  it("documents every generic pattern (no drift)", () => {
    const documented = PATTERN_CATALOG.filter((d) => d.scope === "generic").map((d) => d.name);
    expect([...documented].sort()).toEqual([...GENERIC_PATTERN_NAMES].sort());
  });

  it("keeps generic entries in parser precedence order", () => {
    const documented = PATTERN_CATALOG.filter((d) => d.scope === "generic").map((d) => d.name);
    expect(documented).toEqual([...GENERIC_PATTERN_NAMES]);
  });

  it("documents every adapter pattern (no drift)", () => {
    const documented = PATTERN_CATALOG.filter((d) => d.scope === "adapter").map((d) => `${d.tool}:${d.name}`);
    const known = knownAdapterPatternNames().map((p) => `${p.tool}:${p.name}`);
    expect([...documented].sort()).toEqual([...known].sort());
  });

  it("gives every adapter entry a tool and every generic entry none", () => {
    for (const doc of PATTERN_CATALOG) {
      if (doc.scope === "adapter") expect(doc.tool, `${doc.name} adapter entry needs a tool`).toBeDefined();
      else expect(doc.tool).toBeUndefined();
    }
  });
});

describe("getPatternCatalog", () => {
  it("returns the full catalog when no tool is given", () => {
    expect(getPatternCatalog()).toEqual([...PATTERN_CATALOG]);
  });

  it("returns generic patterns plus only the requested tool's adapter patterns", () => {
    const docs = getPatternCatalog({ tool: "codex-cli" });
    const generic = docs.filter((d) => d.scope === "generic");
    const adapter = docs.filter((d) => d.scope === "adapter");
    expect(generic).toHaveLength(GENERIC_PATTERN_NAMES.length);
    expect(adapter.every((d) => d.tool === "codex-cli")).toBe(true);
    expect(adapter.map((d) => d.name)).toContain("codex-relative-seconds");
    // No cross-tool leakage.
    expect(adapter.map((d) => d.name)).not.toContain("claude-usage-limit-epoch");
  });

  it("returns only generic patterns for a tool with no adapter patterns", () => {
    const docs = getPatternCatalog({ tool: "generic" });
    expect(docs.every((d) => d.scope === "generic")).toBe(true);
    expect(docs).toHaveLength(GENERIC_PATTERN_NAMES.length);
  });

  it("returns fresh copies that don't mutate the catalog", () => {
    const docs = getPatternCatalog();
    docs[0].description = "mutated";
    expect(PATTERN_CATALOG[0].description).not.toBe("mutated");
  });
});
