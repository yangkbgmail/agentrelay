import type { HeartbeatStatus } from "./heartbeat.js";
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
  /**
   * The resume-loop liveness judgment (from `evaluateHeartbeat`). When provided,
   * a few extra gauges are emitted so a scraper can alert on the exact failure
   * mode AgentRelay exists to prevent: jobs waiting to resume while no resume
   * loop is actually running. Omit (or pass `null`) to emit only job-store
   * metrics — backward compatible.
   */
  heartbeat?: HeartbeatStatus | null;
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
 * Resume-loop liveness gauges derived from a {@link HeartbeatStatus}. Kept in a
 * dedicated helper so the job-store metrics and the loop-liveness metrics stay
 * independently testable.
 *
 * - `<prefix>_resume_loop_up{mode}` — 1 when the loop is alive, else 0. The
 *   `mode` label is the writer's mode (`daemon`/`tick`) or `none` when no
 *   heartbeat exists, so a stable series is always emitted for alerting.
 * - `<prefix>_resume_loop_concerning` — 1 when jobs are waiting to resume but
 *   the loop isn't alive (the exact silent-failure AgentRelay guards against),
 *   else 0. Alert on `== 1`.
 * - `<prefix>_resume_loop_last_tick_age_seconds{mode}` — seconds since the last
 *   tick, emitted only when a parseable timestamp exists (absent loop → omitted
 *   rather than a misleading 0).
 */
function heartbeatMetricLines(status: HeartbeatStatus, name: (suffix: string) => string): string[] {
  const lines: string[] = [];
  const mode = status.mode ?? "none";

  lines.push(
    ...metricFamily(name("resume_loop_up"), "Whether the resume loop is alive (1) or not (0).", [
      `${name("resume_loop_up")}{${label("mode", mode)}} ${formatValue(status.state === "alive" ? 1 : 0)}`,
    ])
  );

  lines.push(
    ...metricFamily(
      name("resume_loop_concerning"),
      "1 when jobs are waiting to resume but the loop is not alive (they will not resume on their own), else 0.",
      [`${name("resume_loop_concerning")} ${formatValue(status.concerning ? 1 : 0)}`]
    )
  );

  // Only emit an age when the last-tick timestamp actually parsed; an absent or
  // unparseable heartbeat has no honest age to report.
  if (typeof status.ageMs === "number" && Number.isFinite(status.ageMs)) {
    lines.push(
      ...metricFamily(
        name("resume_loop_last_tick_age_seconds"),
        "Seconds since the resume loop's last tick (now - lastTickAt).",
        [`${name("resume_loop_last_tick_age_seconds")}{${label("mode", mode)}} ${formatValue(status.ageMs / 1000)}`]
      )
    );
  }

  return lines;
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

  // Resume-loop liveness gauges (independent of the job-store scope filter) —
  // only when the caller supplied a heartbeat judgment.
  if (options.heartbeat) {
    lines.push(...heartbeatMetricLines(options.heartbeat, name));
  }

  return `${lines.join("\n")}\n`;
}
