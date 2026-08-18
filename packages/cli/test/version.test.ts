import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { FALLBACK_VERSION, resolveCliVersion } from "../src/version.js";

// The manifest the CLI's version must mirror, read the same way the code does
// but from this test file's own location.
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

describe("resolveCliVersion", () => {
  it("returns the version from the package's own package.json", () => {
    expect(resolveCliVersion()).toBe(pkg.version);
  });

  it("is the single source of truth — matches the manifest exactly, no drift", () => {
    // This is the whole point: the reported version equals the packaged one, so
    // a release bump to package.json is reflected without a second hand-edit.
    expect(resolveCliVersion()).toBe(pkg.version);
    expect(resolveCliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("falls back to a placeholder when no manifest sits next to the module", () => {
    // A path with no adjacent package.json (../package.json unreadable) must not
    // throw — the CLI keeps working with the fallback marker.
    expect(resolveCliVersion("file:///nonexistent/deep/dir/module.js")).toBe(FALLBACK_VERSION);
  });

  it("exposes a 0.0.0-style fallback marker", () => {
    expect(FALLBACK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
