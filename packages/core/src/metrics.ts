import type { RelayStats } from "./stats.js";
import { ALL_TOOLS } from "./stats.js";
import { ALL_STATUSES } from "./summary.js";

/**
 * Renders {@link RelayStats} as Prometheus text exposition format so a local
 * relay can be scraped for observability — e.g. piped into the node_exporter
 * textfile collector (`agentrelay metrics > /var/lib/node_exporter/agentrelay.prom`)
 * or pushed to a Pushgateway. Pure and non-mutating: no I/O, no ambient clock.
 *
 * Kept aggregate-only (unlike `export`, which is one row per job): Prometheus
 * wants low-cardinality gauges, not a sample per job id. Every metric is a gauge
 * because the store can shrink (via `prune`), so nothing here is monotonic.
 */

/**
 * Time-relative, resume-loop signals that {@link RelayStats} cannot carry
 * because it is clock-free. The caller computes these from the same scoped job
 * set (via `buildOverdueReport` / `buildUpcomingTimeline`) and passes them in,
 * keeping {@link renderPrometheusMetrics} pure. When absent, the live gauges are
 * simply omitted — a scraper that never supplies them sees the aggregate
 * metrics exactly as before.
 *
 * The headline signal is `overdueJobs`: `waiting_for_reset` jobs whose reset
 * time has already passed but which have not been resumed. A value that stays
 * above zero is the single clearest sign the resume loop (daemon/tick) is down
 * or the agent binary can't spawn — exactly the silent failure the relay exists
 * to prevent — so it is the natural thing to alert on.
 */
export interface RelayLiveMetrics {
  /** Count of `waiting_for_reset` jobs already past their reset time (grace 0). */
  overdueJobs: number;
  /** Worst single overdue span in ms across those jobs; 0 when none are overdue. */
  maxOverdueMs: number;
  /**
   * Milliseconds until the soonest waiting job's reset, or null when nothing is
   * waiting with a parseable reset. May be ≤ 0 when the soonest reset has
   * already passed (in which case see `overdueJobs`).
   */
  nextResetInMs: number | null;
}

export interface PrometheusOptions {
  /**
   * Metric name prefix (default "agentrelay"). Sanitized to a valid Prometheus
   * metric-name segment: invalid characters become `_`, and a leading digit is
   * prefixed with `_` so the emitted names always parse.
   */
  prefix?: string;
  /**
   * Optional clock-relative resume-loop gauges. Supplied by the caller (which
   * owns `now`) so the render stays pure. Omit to emit aggregate metrics only.
   */
  live?: RelayLiveMetrics;
}

const DEFAULT_PREFIX = "agentrelay";

/**
 * Escape a Prometheus label value per the exposition format: backslash, double
 * quote, and newline are the three characters that must be escaped inside a
 * `label="..."` value. Exported for direct testing.
 */
export function escapePrometheusLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Coerce an arbitrary prefix into a valid Prometheus metric-name segment
 * (`[a-zA-Z_:][a-zA-Z0-9_:]*`). Invalid characters collapse to `_`; an empty or
 * digit-leading result is repaired so the metric names always parse. Exported
 * for direct testing.
 */
export function sanitizeMetricPrefix(prefix: string): string {
  const cleaned = prefix.replace(/[^a-zA-Z0-9_:]/g, "_");
  if (cleaned.length === 0) return DEFAULT_PREFIX;
  // A metric name may not start with a digit — keep the prefix, just guard it.
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** Format a numeric sample value: integers verbatim, others via `String`. */
function formatValue(value: number): string {
  return String(value);
}

/** One label pair rendered as `name="escaped value"`. */
function label(name: string, value: string): string {
  return `${name}="${escapePrometheusLabel(value)}"`;
}

/** Build one metric family: HELP + TYPE header, then its samples. */
function metricFamily(name: string, help: string, samples: string[]): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...samples];
}

/**
 * Renders relay metrics as Prometheus text exposition format. Emits one gauge
 * family per headline metric; resolution-time and success-rate samples are only
 * present when there is data for them (so scrapers don't record a misleading 0
 * or NaN). Output ends with a trailing newline, as scrapers expect.
 */
export function renderPrometheusMetrics(stats: RelayStats, options: PrometheusOptions = {}): string {
  const prefix = sanitizeMetricPrefix(options.prefix ?? DEFAULT_PREFIX);
  const name = (suffix: string) => `${prefix}_${suffix}`;
  const lines: string[] = [];

  lines.push(
    ...metricFamily(name("jobs"), "Total number of jobs tracked in the relay store.", [
      `${name("jobs")} ${formatValue(stats.total)}`,
    ])
  );

  lines.push(
    ...metricFamily(name("jobs_by_status"), "Number of jobs per status.", [
      ...ALL_STATUSES.map((s) => `${name("jobs_by_status")}{${label("status", s)}} ${formatValue(stats.byStatus[s])}`),
    ])
  );

  lines.push(
    ...metricFamily(name("jobs_by_tool"), "Number of jobs per agent tool.", [
      ...ALL_TOOLS.map((t) => `${name("jobs_by_tool")}{${label("tool", t)}} ${formatValue(stats.byTool[t])}`),
    ])
  );

  lines.push(
    ...metricFamily(name("jobs_active"), "Jobs the relay is still working (queued + waiting_for_reset + resuming).", [
      `${name("jobs_active")} ${formatValue(stats.active)}`,
    ])
  );

  lines.push(
    ...metricFamily(name("jobs_terminal"), "Jobs in a final state (completed + failed + cancelled).", [
      `${name("jobs_terminal")} ${formatValue(stats.terminal)}`,
    ])
  );

  lines.push(
    ...metricFamily(name("attempts"), "Total resume attempts summed across every job.", [
      `${name("attempts")} ${formatValue(stats.totalAttempts)}`,
    ])
  );

  lines.push(
    ...metricFamily(name("retried_jobs"), "Jobs resumed more than once (attempts > 1).", [
      `${name("retried_jobs")} ${formatValue(stats.retriedJobs)}`,
    ])
  );

  // Success rate is null until something resolves; omit the sample rather than
  // emit a misleading 0 or a NaN literal.
  if (stats.successRate !== null) {
    lines.push(
      ...metricFamily(name("success_rate"), "completed / (completed + failed), in [0, 1]. Cancelled jobs excluded.", [
        `${name("success_rate")} ${formatValue(stats.successRate)}`,
      ])
    );
  }

  lines.push(
    ...metricFamily(name("resolved_jobs"), "Jobs that contributed a valid resolution-time span.", [
      `${name("resolved_jobs")} ${formatValue(stats.timing.resolvedCount)}`,
    ])
  );

  // Resolution-time gauges (in seconds, Prometheus base unit) only when at least
  // one job resolved — otherwise every stat is null.
  const t = stats.timing;
  if (
    t.avgResolutionMs !== null &&
    t.minResolutionMs !== null &&
    t.maxResolutionMs !== null &&
    t.medianResolutionMs !== null &&
    t.p90ResolutionMs !== null
  ) {
    const metric = name("resolution_seconds");
    lines.push(
      ...metricFamily(metric, "Job resolution time (updatedAt - createdAt) over completed + failed jobs, seconds.", [
        `${metric}{${label("stat", "avg")}} ${formatValue(t.avgResolutionMs / 1000)}`,
        `${metric}{${label("stat", "min")}} ${formatValue(t.minResolutionMs / 1000)}`,
        `${metric}{${label("stat", "median")}} ${formatValue(t.medianResolutionMs / 1000)}`,
        `${metric}{${label("stat", "p90")}} ${formatValue(t.p90ResolutionMs / 1000)}`,
        `${metric}{${label("stat", "max")}} ${formatValue(t.maxResolutionMs / 1000)}`,
      ])
    );
  }

  // Clock-relative resume-loop gauges, only when the caller supplied them.
  // `overdue_jobs` is the one to alert on: a persistent non-zero value means the
  // relay has jobs whose reset already passed but nothing is resuming them.
  const live = options.live;
  if (live !== undefined) {
    lines.push(
      ...metricFamily(
        name("overdue_jobs"),
        "waiting_for_reset jobs whose reset time has already passed but which have not resumed (resume-loop-down signal).",
        [`${name("overdue_jobs")} ${formatValue(live.overdueJobs)}`]
      )
    );

    // Only meaningful when something is actually overdue — a "max" over an empty
    // set would be a misleading 0, so omit the family entirely otherwise.
    if (live.overdueJobs > 0) {
      const metric = name("overdue_seconds");
      lines.push(
        ...metricFamily(metric, "How long the most-overdue waiting job has been past its reset time, seconds.", [
          `${metric}{${label("stat", "max")}} ${formatValue(live.maxOverdueMs / 1000)}`,
        ])
      );
    }

    // Seconds until the soonest waiting job's reset. Omitted when nothing is
    // waiting; can be ≤ 0 when the soonest reset has already passed.
    if (live.nextResetInMs !== null) {
      lines.push(
        ...metricFamily(
          name("next_reset_seconds"),
          "Seconds until the soonest waiting job's reset (negative once it has passed).",
          [`${name("next_reset_seconds")} ${formatValue(live.nextResetInMs / 1000)}`]
        )
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
