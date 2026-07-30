// A single consolidated snapshot of the relay's health, composing the four
// observability views the CLI already exposes separately — stats, errors,
// rate-limit patterns, and the next resume — into one structured object. This
// powers `agentrelay report`, which answers "how is my relay doing?" in one
// shot (and one shareable document) instead of running four commands and
// eyeballing them together.
//
// Pure and deterministic: every sub-view is itself a pure function and the only
// clock input is the injected `nowMs`, so the whole report is unit-testable
// without a store or a wall clock. Building on the already-tested composed
// functions means this module adds no new parsing/aggregation logic — just the
// composition and a top-N truncation of the two long lists.

import { computeErrorBreakdown, type ErrorGroup } from "./errors.js";
import { type NextResume, selectNextResume } from "./next.js";
import { type RateLimitPatternStat, summarizeRateLimitPatterns } from "./patterns.js";
import { computeStats, type RelayStats } from "./stats.js";
import type { RelayJob } from "./types.js";

/** Default number of error reasons / rate-limit patterns to surface in a report. */
export const DEFAULT_REPORT_TOP = 5;

/** Aggregate counts from the error breakdown, without the (possibly long) group list. */
export interface ReportErrorTotals {
  /** Jobs carrying a non-empty `lastError`. */
  totalWithErrors: number;
  /** Number of distinct normalized error signatures. */
  distinctSignatures: number;
}

/** Aggregate counts from the rate-limit pattern summary, without the pattern list. */
export interface ReportPatternTotals {
  /** Total jobs considered (after any scope the caller applied). */
  total: number;
  /** Jobs carrying a usable rate-limit detection (a non-empty pattern name). */
  withDetection: number;
  /** Jobs with no detection recorded. */
  withoutDetection: number;
}

/**
 * A consolidated, structured snapshot of the relay: the full stats block plus
 * top-ranked failure reasons, top-ranked rate-limit patterns, and the next
 * resume. The two long lists are truncated to a top-N in {@link buildRelayReport}
 * so the report stays a fixed-size "headline"; the accompanying totals still
 * reflect every job, so nothing is silently hidden.
 */
export interface RelayReport {
  /** When the report was generated (epoch ms, injected — keeps this pure). */
  generatedAtMs: number;
  /** Jobs considered (after any scope the caller applied). */
  totalJobs: number;
  /** Full queue statistics (counts, success rate, resolution timing). */
  stats: RelayStats;
  /** Aggregate error counts (totals reflect every job, not just {@link topErrors}). */
  errorTotals: ReportErrorTotals;
  /** Top failure reasons ranked by frequency (truncated to the `topErrors` option). */
  topErrors: ErrorGroup[];
  /** Aggregate rate-limit detection counts (reflect every job, not just {@link topPatterns}). */
  patternTotals: ReportPatternTotals;
  /** Top rate-limit patterns ranked by frequency (truncated to the `topPatterns` option). */
  topPatterns: RateLimitPatternStat[];
  /** The single job the relay resumes next, or null when nothing is waiting. */
  nextResume: NextResume | null;
}

/** Options for {@link buildRelayReport}. */
export interface ReportOptions {
  /** "Now" as epoch ms, used to compute the next resume's countdown. */
  nowMs: number;
  /**
   * Max error reasons to include in {@link RelayReport.topErrors}. Defaults to
   * {@link DEFAULT_REPORT_TOP}; a value `<= 0` means "no cap, include all".
   */
  topErrors?: number;
  /**
   * Max rate-limit patterns to include in {@link RelayReport.topPatterns}.
   * Defaults to {@link DEFAULT_REPORT_TOP}; a value `<= 0` means "include all".
   */
  topPatterns?: number;
}

/** Take the first `n` items, or all of them when `n <= 0` (uncapped). Never mutates. */
function takeTop<T>(items: T[], n: number): T[] {
  return n <= 0 ? items.slice() : items.slice(0, n);
}

/**
 * Compose the four relay observability views (stats, error breakdown, rate-limit
 * patterns, next resume) into one {@link RelayReport}. Pure and non-mutating:
 * delegates every calculation to the existing tested functions and only adds the
 * composition plus a top-N truncation of the error/pattern lists. The counts in
 * {@link RelayReport.errorTotals} / {@link RelayReport.patternTotals} always
 * reflect the full job set, independent of the truncation, so a small `topErrors`
 * never misrepresents how many failures there really were.
 */
export function buildRelayReport(jobs: RelayJob[], options: ReportOptions): RelayReport {
  const topErrorsN = options.topErrors ?? DEFAULT_REPORT_TOP;
  const topPatternsN = options.topPatterns ?? DEFAULT_REPORT_TOP;

  const stats = computeStats(jobs);
  const breakdown = computeErrorBreakdown(jobs);
  const patterns = summarizeRateLimitPatterns(jobs);
  const nextResume = selectNextResume(jobs, options.nowMs);

  return {
    generatedAtMs: options.nowMs,
    totalJobs: jobs.length,
    stats,
    errorTotals: {
      totalWithErrors: breakdown.totalWithErrors,
      distinctSignatures: breakdown.distinctSignatures,
    },
    topErrors: takeTop(breakdown.groups, topErrorsN),
    patternTotals: {
      total: patterns.total,
      withDetection: patterns.withDetection,
      withoutDetection: patterns.withoutDetection,
    },
    topPatterns: takeTop(patterns.patterns, topPatternsN),
    nextResume,
  };
}
