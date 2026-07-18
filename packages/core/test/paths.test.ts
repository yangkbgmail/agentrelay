import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultStorePath, expandTilde } from "../src/paths.js";

describe("expandTilde", () => {
  it("expands a bare ~ to the home directory", () => {
    expect(expandTilde("~", "/home/alice")).toBe("/home/alice");
  });

  it("expands ~/rest to home + rest", () => {
    expect(expandTilde("~/.agentrelay/jobs.json", "/home/alice")).toBe("/home/alice/.agentrelay/jobs.json");
  });

  it("leaves absolute and relative paths untouched", () => {
    expect(expandTilde("/tmp/jobs.json", "/home/alice")).toBe("/tmp/jobs.json");
    expect(expandTilde("./jobs.json", "/home/alice")).toBe("./jobs.json");
  });

  it("does not touch a ~user form it cannot resolve", () => {
    expect(expandTilde("~bob/jobs.json", "/home/alice")).toBe("~bob/jobs.json");
  });
});

describe("defaultStorePath", () => {
  it("falls back to ~/.agentrelay/jobs.json when no override is set", () => {
    expect(defaultStorePath({})).toBe(join(homedir(), ".agentrelay", "jobs.json"));
  });

  it("uses AGENTRELAY_STORE and expands a leading tilde in it", () => {
    const store = defaultStorePath({ AGENTRELAY_STORE: "~/custom/jobs.json" });
    expect(store).toBe(join(homedir(), "custom", "jobs.json"));
  });

  it("passes an absolute override through unchanged", () => {
    expect(defaultStorePath({ AGENTRELAY_STORE: "/var/jobs.json" })).toBe("/var/jobs.json");
  });
});
