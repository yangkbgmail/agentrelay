import { createRequire } from "node:module";

/**
 * The CLI version, read from the package's own `package.json` instead of a
 * hand-maintained literal.
 *
 * The `--version` string used to be hardcoded (`.version("0.1.0")`), so every
 * release had to remember to bump it in two places — the package manifest *and*
 * the source — or `agentrelay --version` would silently report a stale, wrong
 * version. Reading the manifest at runtime makes `package.json` the single
 * source of truth: bump it once and the CLI reports the truth.
 *
 * Resolution works identically in tests and in the built CLI because `src/` and
 * `dist/` sit at the same depth under `packages/cli/`, so `../package.json`
 * points at the one real manifest whether this module runs as `src/version.ts`
 * (vitest, TS source) or `dist/version.js` (the shipped build).
 */

/**
 * Hard fallback returned when the manifest can't be read (e.g. the CLI was
 * bundled into a single file that no longer sits next to `package.json`). A
 * `0.0.0`-style placeholder is the conventional "unknown/dev build" marker and
 * keeps `--version` working rather than throwing.
 */
export const FALLBACK_VERSION = "0.0.0";

/**
 * Read the CLI's version from its `package.json`. Pure aside from the one file
 * read, and defensive: a missing/unreadable manifest, unparseable JSON, or a
 * manifest with no usable `version` string all resolve to {@link FALLBACK_VERSION}
 * so the CLI never fails to start over version bookkeeping.
 *
 * @param fromUrl Module URL the manifest is resolved relative to; defaults to
 *   this module's own location. Injectable so tests can point at a path with no
 *   adjacent manifest and assert the fallback.
 */
export function resolveCliVersion(fromUrl: string = import.meta.url): string {
  try {
    const require = createRequire(fromUrl);
    const pkg = require("../package.json") as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.trim() !== "") {
      return pkg.version;
    }
    return FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}
