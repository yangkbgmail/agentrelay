import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultStorePath, expandTilde } from "../src/paths.js";

describe("expandTilde", () => {
  const home = "/home/tester";

  it("expands a bare ~ to the home directory", () => {
    expect(expandTilde("~", home)).toBe(home);
  });

  it("expands a leading ~/ to a path under home", () => {
    expect(expandTilde("~/.agentrelay/jobs.json", home)).toBe(join(home, ".agentrelay/jobs.json"));
  });

  it("leaves absolute and relative paths untouched", () => {
    expect(expandTilde("/var/lib/jobs.json", home)).toBe("/var/lib/jobs.json");
    expect(expandTilde("./jobs.json", home)).toBe("./jobs.json");
    // A ~ that is not a leading path segment must not be expanded.
    expect(expandTilde("backup~/jobs.json", home)).toBe("backup~/jobs.json");
  });
});

describe("defaultStorePath", () => {
  it("expands a ~ in AGENTRELAY_STORE so it never creates a literal '~' dir", () => {
    const resolved = defaultStorePath({ AGENTRELAY_STORE: "~/.agentrelay/jobs.json" });
    expect(resolved.startsWith("~")).toBe(false);
    expect(resolved.endsWith(".agentrelay/jobs.json")).toBe(true);
  });

  it("returns an absolute AGENTRELAY_STORE unchanged", () => {
    expect(defaultStorePath({ AGENTRELAY_STORE: "/tmp/custom.json" })).toBe("/tmp/custom.json");
  });

  it("falls back to ~/.agentrelay/jobs.json when unset", () => {
    expect(defaultStorePath({})).toMatch(/\.agentrelay[/\\]jobs\.json$/);
  });
});
