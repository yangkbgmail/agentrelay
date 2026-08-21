import type { RateLimitDetection } from "@agentrelay/core";

/**
 * Rate-limit detection *provenance* for the dashboard.
 *
 * When the relay parks a job in `waiting_for_reset`, it records *why*: which
 * parser pattern fired, the exact text it matched, and when — the
 * {@link RateLimitDetection} persisted on the job. The CLI surfaces this through
 * `agentrelay show`; the dashboard's job table showed only the resulting
 * countdown, leaving the #1 debugging question ("why does the relay think the
 * reset is at that time?") unanswerable in the browser. This module is the pure,
 * node-testable display layer the client renders from — no React, no DOM.
 */

/** Max characters of matched raw text shown inline before eliding with `…`. */
export const MATCH_PREVIEW_MAX = 120;

/**
 * Collapse a matched raw substring to a single tidy line for inline display:
 * runs of whitespace (including the newlines common in multi-line agent output)
 * become single spaces, the ends are trimmed, and anything past `max` characters
 * is elided with a trailing `…`. Pure and deterministic.
 */
export function truncateMatch(raw: string, max: number = MATCH_PREVIEW_MAX): string {
  const clean = raw.replace(/\s+/g, " ").trim();
  if (max <= 0) return "";
  if (clean.length <= max) return clean;
  // Reserve one character for the ellipsis so the result never exceeds `max`.
  return `${clean.slice(0, max - 1)}…`;
}

/** A flattened, display-ready view of one {@link RateLimitDetection}. */
export interface DetectionView {
  /** Name of the parser pattern that matched (e.g. `claude-code-epoch`). */
  pattern: string;
  /** The matched text, whitespace-collapsed and truncated for inline display. */
  matchPreview: string;
  /** Whether the match was truncated (so the UI can hint "full text elsewhere"). */
  truncated: boolean;
  /** ISO timestamp the detection produced for the reset. */
  resetAt: string;
  /** ISO timestamp the detection was recorded; the client localizes it. */
  detectedAt: string;
}

/**
 * Flatten a {@link RateLimitDetection} into the {@link DetectionView} the job
 * table renders. Keeps the timestamp formatting in the client (which knows the
 * viewer's locale/timezone) and does only the locale-independent work here so it
 * stays unit-testable.
 */
export function describeDetection(detection: RateLimitDetection): DetectionView {
  const matchPreview = truncateMatch(detection.rawMatch);
  return {
    pattern: detection.pattern,
    matchPreview,
    truncated: matchPreview !== detection.rawMatch.replace(/\s+/g, " ").trim(),
    resetAt: detection.resetAt,
    detectedAt: detection.detectedAt,
  };
}
