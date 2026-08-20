import { ADAPTERS } from "./adapters.js";
import type { AgentTool } from "./types.js";

/**
 * A human-facing catalog of every rate-limit message format AgentRelay
 * recognizes. The parser (`parser.ts`) and the adapters (`adapters.ts`) hold
 * the *matchers*; this module holds the *documentation* — a description and a
 * real example for each named pattern — so users can see, at a glance, exactly
 * which agent-CLI wordings AgentRelay will detect and queue for auto-resume.
 *
 * Why a separate curated table rather than reflecting off the regexes? A regex
 * source string is not a human explanation, and there's no reliable way to
 * generate a *matching* example from an arbitrary pattern. Instead we hand-write
 * one canonical example per pattern and let a test (`catalog.test.ts`) prove two
 * invariants so this file can never silently drift from the real parser:
 *   1. every catalog example actually parses to the pattern it documents, and
 *   2. every known pattern (generic + adapter) is documented here — adding a new
 *      pattern without a catalog entry fails the drift test.
 *
 * Everything here is pure data + pure functions: no filesystem, no clock.
 */

/** Where a pattern comes from: the built-in generic parser, or a tool adapter. */
export type PatternScope = "generic" | "adapter";

/** One documented rate-limit pattern. */
export interface PatternDoc {
  /** The pattern's `name`, matching `RateLimitInfo.pattern` when it fires. */
  name: string;
  /** Generic (built-in) or adapter (tool-specific). */
  scope: PatternScope;
  /** For adapter patterns, the tool whose adapter contributes it. */
  tool?: AgentTool;
  /** One-line, human-readable description of the wording it recognizes. */
  description: string;
  /** A canonical example message that this pattern matches. */
  example: string;
}

/**
 * The full catalog. Generic entries are ordered as the parser tries them (first
 * match wins), so reading top-to-bottom mirrors the parser's precedence. Adapter
 * entries follow, grouped by tool.
 */
export const PATTERN_CATALOG: readonly PatternDoc[] = [
  {
    name: "iso-timestamp",
    scope: "generic",
    description: "An explicit ISO-8601 reset instant after 'reset at' (date, time, optional zone).",
    example: "Your limit will reset at 2026-07-13T05:00:00Z.",
  },
  {
    name: "clock-time",
    scope: "generic",
    description:
      "A wall-clock reset time with minutes ('reset at 3:30pm' / 'reset at 15:00'); rolls to tomorrow if already past.",
    example: "Your limit will reset at 3:30pm.",
  },
  {
    name: "clock-time-meridiem",
    scope: "generic",
    description:
      "A wall-clock reset hour with am/pm but no minutes ('reset at 5pm') — the wording Claude Code actually prints.",
    example: "Your limit will reset at 5pm.",
  },
  {
    name: "relative-duration",
    scope: "generic",
    description:
      "A relative wait in days/hours/minutes ('try again in 4h 32m' / 'resets in 1d 4h'). Seconds are handled by the Codex adapter.",
    example: "Please try again in 4h 32m.",
  },
  {
    name: "unix-epoch",
    scope: "generic",
    description:
      "A Unix epoch-seconds reset in a structured 'retry_after' field ('retry_after: 1752345600' or its JSON form).",
    example: '{"retry_after": 1752345600}',
  },
  {
    name: "http-retry-after",
    scope: "generic",
    description:
      "The standard HTTP 'Retry-After' header (RFC 9110): delay-seconds ('Retry-After: 3600') or an HTTP-date.",
    example: "Retry-After: 3600",
  },
  {
    name: "five-hour-window-fallback",
    scope: "generic",
    description:
      "A low-confidence fallback: a bare '5-hour limit' mention with no explicit time is treated as a full 5h window from now.",
    example: "You've hit your 5-hour usage limit.",
  },
  {
    name: "codex-relative-seconds",
    scope: "adapter",
    tool: "codex-cli",
    description:
      "OpenAI/Codex-style sub-minute waits phrased in seconds ('try again in 20s' / 'try again in 1.5s'), rounded up.",
    example: "Rate limit reached. Please try again in 20s.",
  },
  {
    name: "claude-usage-limit-epoch",
    scope: "adapter",
    tool: "claude-code",
    description:
      "Claude Code's headless (`claude -p`) machine format: 'usage limit reached|<unix_epoch_seconds>' (absolute reset).",
    example: "Claude AI usage limit reached|1752345600",
  },
];

/**
 * Return the catalog entries relevant to a query. With no `tool`, returns every
 * generic pattern plus every adapter pattern (the full catalog). With a `tool`,
 * returns the generic patterns plus only that tool's adapter patterns — mirroring
 * how `resolveAdapter(tool)` layers a tool's patterns on top of the generic ones.
 * Always returns a fresh array; never mutates the catalog. Pure.
 */
export function getPatternCatalog(options: { tool?: AgentTool } = {}): PatternDoc[] {
  const { tool } = options;
  return PATTERN_CATALOG.filter((doc) => {
    if (doc.scope === "generic") return true;
    if (tool === undefined) return true;
    return doc.tool === tool;
  }).map((doc) => ({ ...doc }));
}

/**
 * All known pattern names, generic first (in parser order) then adapter patterns
 * grouped by tool — derived from the live {@link ADAPTERS} registry so the drift
 * test can compare the catalog against reality. Adapter names are de-duplicated
 * in case two tools ever share a pattern instance.
 */
export function knownAdapterPatternNames(): { tool: AgentTool; name: string }[] {
  const out: { tool: AgentTool; name: string }[] = [];
  const seen = new Set<string>();
  for (const [tool, adapter] of Object.entries(ADAPTERS) as [AgentTool, (typeof ADAPTERS)[AgentTool]][]) {
    for (const pattern of adapter.patterns) {
      const key = `${tool}:${pattern.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ tool, name: pattern.name });
    }
  }
  return out;
}
