import { getPatternCatalog } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_FORMATS_MESSAGE, renderCatalog, renderCatalogJson } from "../src/formats.js";

describe("renderCatalog", () => {
  it("lists every recognized format with its example", () => {
    const docs = getPatternCatalog();
    const out = renderCatalog(docs);
    expect(out).toContain(`${docs.length} rate-limit format(s) recognized`);
    // A representative generic and adapter pattern both appear, with examples.
    expect(out).toContain("iso-timestamp");
    expect(out).toContain("codex-relative-seconds");
    for (const doc of docs) {
      expect(out).toContain(doc.name);
      expect(out).toContain(doc.description);
      expect(out).toContain(JSON.stringify(doc.example));
    }
  });

  it("groups generic patterns before adapter patterns under a tool heading", () => {
    const out = renderCatalog(getPatternCatalog());
    const genericIdx = out.indexOf("Generic patterns");
    const adapterIdx = out.indexOf("Adapter patterns: codex-cli");
    expect(genericIdx).toBeGreaterThanOrEqual(0);
    expect(adapterIdx).toBeGreaterThan(genericIdx);
  });

  it("shows only the requested tool's adapter section when scoped", () => {
    const out = renderCatalog(getPatternCatalog({ tool: "codex-cli" }));
    expect(out).toContain("Adapter patterns: codex-cli");
    expect(out).not.toContain("Adapter patterns: claude-code");
  });

  it("emits ANSI codes only when color is on", () => {
    const docs = getPatternCatalog({ tool: "generic" });
    expect(renderCatalog(docs, { color: false })).not.toContain("\x1b[");
    expect(renderCatalog(docs, { color: true })).toContain("\x1b[");
  });

  it("shows a placeholder when there is nothing to render", () => {
    expect(renderCatalog([])).toBe(NO_FORMATS_MESSAGE);
  });
});

describe("renderCatalogJson", () => {
  it("round-trips the formats and echoes the tool scope", () => {
    const formats = getPatternCatalog({ tool: "claude-code" });
    const parsed = JSON.parse(renderCatalogJson({ tool: "claude-code", formats }));
    expect(parsed.tool).toBe("claude-code");
    expect(parsed.formats).toEqual(formats);
    // No other tool's adapter pattern leaks in.
    const adapterTools = parsed.formats
      .filter((d: { scope: string }) => d.scope === "adapter")
      .map((d: { tool: string }) => d.tool);
    expect([...new Set(adapterTools)]).toEqual(["claude-code"]);
  });
});
