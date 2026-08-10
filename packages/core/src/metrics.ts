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

export interface PrometheusOptions {
  /**
   * Metric name prefix (default "agentrelay"). Sanitized to a valid Prometheus
   * metric-name segment: invalid characters become `_`, and a leading digit is
   * prefixed with `_` so the emitted names always parse.
   */
  prefix?: string;
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

  // Absolute Unix timestamp (seconds) of the soonest waiting job's reset — the
  // idiomatic Prometheus way to expose a future instant (cf. node_boot_time_seconds):
  // the scraper stores an absolute time and computes the countdown in PromQL
  // (`agentrelay_next_reset_timestamp_seconds - time()`), so this stays pure with
  // no ambient clock. Omitted entirely when nothing is waiting (or the stored
  // timestamp is unparseable), matching the null-omission convention below — an
  // absent series reads as "queue is drained", not a misleading 0/epoch.
  if (stats.nextResetAt !== null) {
    const resetMs = Date.parse(stats.nextResetAt);
    if (!Number.isNaN(resetMs)) {
      const metric = name("next_reset_timestamp_seconds");
      lines.push(
        ...metricFamily(
          metric,
          "Unix timestamp (seconds) of the earliest waiting job's rate-limit reset; absent when nothing waits.",
          [`${metric} ${formatValue(resetMs / 1000)}`]
        )
      );
    }
  }

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
    t.p25ResolutionMs !== null &&
    t.p75ResolutionMs !== null &&
    t.p90ResolutionMs !== null &&
    t.p95ResolutionMs !== null &&
    t.p99ResolutionMs !== null &&
    t.iqrResolutionMs !== null &&
    t.stdevResolutionMs !== null
  ) {
    // One gauge family, `stat`-labeled, exposing the full resolution-time
    // distribution `computeStats` already computes: central + percentiles
    // (min…max) plus the two dispersion measures (iqr, stdev). All are durations
    // in seconds, so they share the family; a scraper picks the series it wants.
    const metric = name("resolution_seconds");
    lines.push(
      ...metricFamily(metric, "Job resolution time (updatedAt - createdAt) over completed + failed jobs, seconds.", [
        `${metric}{${label("stat", "avg")}} ${formatValue(t.avgResolutionMs / 1000)}`,
        `${metric}{${label("stat", "min")}} ${formatValue(t.minResolutionMs / 1000)}`,
        `${metric}{${label("stat", "p25")}} ${formatValue(t.p25ResolutionMs / 1000)}`,
        `${metric}{${label("stat", "median")}} ${formatValue(t.medianResolutionMs / 1000)}`,
        `${metric}{${label("stat", "p75")}} ${formatValue(t.p75ResolutionMs / 1000)}`,
        `${metric}{${label("stat", "p90")}} ${formatValue(t.p90ResolutionMs / 1000)}`,
        `${metric}{${label("stat", "p95")}} ${formatValue(t.p95ResolutionMs / 1000)}`,
        `${metric}{${label("stat", "p99")}} ${formatValue(t.p99ResolutionMs / 1000)}`,
        `${metric}{${label("stat", "max")}} ${formatValue(t.maxResolutionMs / 1000)}`,
        `${metric}{${label("stat", "iqr")}} ${formatValue(t.iqrResolutionMs / 1000)}`,
        `${metric}{${label("stat", "stdev")}} ${formatValue(t.stdevResolutionMs / 1000)}`,
      ])
    );
  }

  return `${lines.join("\n")}\n`;
}
