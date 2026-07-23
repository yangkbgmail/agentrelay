// Line-granular rate-limit scanning for `agentrelay parse --scan`.
//
// The single-message `parse` (buildParseReport) runs the parser over one blob
// and returns the *first* hit — perfect for "would this one message trigger a
// resume?" but useless for auditing a whole log: a captured agent session can
// contain many rate-limit events over hours, and you want to see *all* of them,
// which line each is on, and which patterns actually fired.
//
// `scanRateLimits` splits the input into lines and runs the adapter's detector
// on each line independently, collecting every match plus a pattern-frequency
// table. Pure: no filesystem, no ambient clock unless `now` is injected. The
// scan is line-granular by design — the built-in patterns each match within a
// single line (see parser.ts), so this mirrors how rate-limit messages actually
// appear in CLI output. A detection that would only match across a line break
// is out of scope here (the whole-blob `parse` remains for that case).

import { resolveAdapter } from "./adapters.js";
import type { AgentTool } from "./types.js";

/** One line of the input that the parser flagged as a rate-limit message. */
export interface ScanMatch {
  /** 1-based line number in the scanned input. */
  line: number;
  /** The full text of the matching line (trailing CR/whitespace trimmed). */
  text: string;
  /** Named parser pattern that matched (see parser.ts / adapters.ts). */
  pattern: string;
  /** The raw substring of the line that matched. */
  rawMatch: string;
  /** ISO timestamp of the reset this detection produced. */
  resetAt: string;
}

/** How often each pattern fired across the scanned input. */
export interface ScanPatternStat {
  pattern: string;
  count: number;
}

export interface ScanResult {
  /** Adapter actually used (after resolving `tool` → generic default). */
  tool: AgentTool;
  /** Number of lines scanned (a single trailing newline is not counted). */
  totalLines: number;
  /** Number of lines that produced a detection. */
  matchedLines: number;
  /** Every matching line, in input order. */
  matches: ScanMatch[];
  /** Pattern frequency, ranked count desc then name asc. */
  patterns: ScanPatternStat[];
}

export interface ScanOptions {
  /** Explicit tool adapter to use; falls back to the generic one. */
  tool?: AgentTool;
  /** Injectable "now" for deterministic tests / relative-duration resolution. */
  now?: Date;
}

/**
 * Split text into lines for scanning. Empty input yields zero lines; a single
 * trailing newline is dropped so `"a\nb\n"` counts as two lines, not three.
 */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\r?\n$/, "").split(/\r?\n/);
}

/**
 * Scan `text` line by line for rate-limit messages using the given tool's
 * adapter (its extra patterns are tried before the generic ones). Returns every
 * matching line plus a pattern-frequency table. Pure aside from `now`, which the
 * core parser defaults when omitted.
 */
export function scanRateLimits(text: string, options: ScanOptions = {}): ScanResult {
  const adapter = resolveAdapter({ tool: options.tool });
  const detectOptions = options.now ? { now: options.now } : {};
  const lines = splitLines(text);

  const matches: ScanMatch[] = [];
  const counts = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, "");
    const info = adapter.detectRateLimit(line, detectOptions);
    if (!info) continue;
    matches.push({
      line: i + 1,
      text: line,
      pattern: info.pattern,
      rawMatch: info.rawMatch,
      resetAt: info.resetAt,
    });
    counts.set(info.pattern, (counts.get(info.pattern) ?? 0) + 1);
  }

  const patterns: ScanPatternStat[] = [...counts.entries()]
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));

  return {
    tool: adapter.tool,
    totalLines: lines.length,
    matchedLines: matches.length,
    matches,
    patterns,
  };
}
