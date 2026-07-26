import { generateManPage } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { buildCli, buildManPageSpec } from "../src/cli.js";

describe("buildManPageSpec", () => {
  const spec = buildManPageSpec(buildCli(), "2026-07-26");

  it("derives program name, version and description from the live program", () => {
    expect(spec.program).toBe("agentrelay");
    expect(spec.version).toBe("0.1.0");
    expect(spec.description).toContain("rate-limit");
    expect(spec.date).toBe("2026-07-26");
  });

  it("carries the global --store/--config options", () => {
    const flags = spec.options.map((o) => o.flags);
    expect(flags.some((f) => f.includes("--store"))).toBe(true);
    expect(flags.some((f) => f.includes("--config"))).toBe(true);
  });

  it("includes every top-level command with a description", () => {
    const names = spec.commands.map((c) => c.name);
    for (const expected of ["run", "status", "stats", "export", "config", "man", "completion"]) {
      expect(names).toContain(expected);
    }
    for (const cmd of spec.commands) {
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });

  it("captures a command's arguments in the usage tail", () => {
    const run = spec.commands.find((c) => c.name === "run");
    expect(run?.args).toBe("<command...>");
  });

  it("nests config's subcommands (init/show/set/...) under it", () => {
    const config = spec.commands.find((c) => c.name === "config");
    expect(config).toBeDefined();
    const subNames = (config?.subcommands ?? []).map((s) => s.name);
    for (const expected of ["init", "show", "set"]) {
      expect(subNames).toContain(expected);
    }
  });

  it("produces a man page that references real commands and files", () => {
    const page = generateManPage(spec);
    expect(page).toContain(".TH AGENTRELAY 1");
    expect(page).toContain(".SS run");
    expect(page).toContain(".SS config");
    expect(page).toContain(".SH FILES");
    // Balanced .RS/.RE blocks (one open per subcommand block, one close each).
    const opens = (page.match(/^\.RS/gm) ?? []).length;
    const closes = (page.match(/^\.RE/gm) ?? []).length;
    expect(opens).toBe(closes);
    expect(opens).toBeGreaterThan(0);
  });
});
