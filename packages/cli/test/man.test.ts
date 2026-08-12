import { generateManPage } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { buildCli, buildManSpec } from "../src/cli.js";

describe("buildManSpec — derived from the live commander program", () => {
  const spec = buildManSpec(buildCli());

  it("carries the program name, version, and summary", () => {
    expect(spec.program).toBe("agentrelay");
    expect(spec.version).toBe("0.1.0");
    expect(spec.summary).toMatch(/rate-limit/);
  });

  it("includes global options with their descriptions", () => {
    const store = spec.options.find((o) => o.flags.includes("--store"));
    expect(store?.description).toMatch(/job store/i);
  });

  it("includes real commands with descriptions (e.g. status)", () => {
    const status = spec.commands.find((c) => c.name === "status");
    expect(status).toBeTruthy();
    expect(status?.description).toMatch(/jobs/i);
    expect(status?.usage).toContain("[options]");
  });

  it("nests parent-command subcommands (e.g. config init/show)", () => {
    const config = spec.commands.find((c) => c.name === "config");
    const subNames = (config?.subcommands ?? []).map((s) => s.name);
    expect(subNames).toContain("init");
    expect(subNames).toContain("show");
  });

  it("does not itself appear as a stale hand-kept list — man is one of the commands", () => {
    expect(spec.commands.map((c) => c.name)).toContain("man");
  });

  it("renders to a valid roff page via generateManPage", () => {
    const page = generateManPage(spec, { date: "2026-08-12" });
    expect(page.startsWith(".TH AGENTRELAY 1 ")).toBe(true);
    expect(page).toContain(".SH COMMANDS");
    expect(page).toContain(".SS status");
    expect(page).toContain(".SS config init");
    // flags are hyphen-escaped for roff
    expect(page).toContain(".B \\-\\-store <path>");
  });
});
