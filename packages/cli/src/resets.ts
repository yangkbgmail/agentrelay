// Rendering for `agentrelay resets` — an hour-of-day clock of when the relay
// actually hit rate limits (`lastRateLimit.detectedAt`), or when the quota
// window rolled over (`--reset` → `lastRateLimit.resetAt`). Every other
// histogram (`stats --hours/--weekday/--heatmap`) buckets on when jobs were
// *created*; this is the only view keyed off the persisted rate-limit
// provenance, so it answers "when do I keep getting throttled?" rather than
// "when did I enqueue work?". Kept as pure functions (separate from the
// commander wiring) so the output is testable without a TTY, a clock, or a
// spawned process.

import type { ResetClock } from "@agentrelay/core";
import { formatUtcOffsetLabel } from "./stats.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Max width (chars) of a full-scale bar in the reset-clock histogram. */
const CLOCK_BAR_WIDTH = 24;

/** Shown when no job in scope carries a rate-limit detection to place on the clock. */
export const NO_RESETS_MESSAGE = "No rate-limit detections recorded yet — nothing to place on the clock.";

/** Human-readable phrase for the basis, used in headers/footers. */
function basisPhrase(clock: ResetClock): string {
  return clock.basis === "reset" ? "rate-limit resets per hour of day" : "rate-limit hits per hour of day";
}

/**
 * Human-friendly ASCII bar chart of the reset clock: one row per hour (00:00 →
 * 23:00), bars scaled to the busiest hour so the shape reads regardless of
 * absolute volume, a dim baseline dot for quiet hours, and a footer naming the
 * modal hour and total. Reuses `formatUtcOffsetLabel` so the zone label matches
 * `stats --hours` exactly. Pure: no I/O, no clock — the caller passes the
 * already-computed {@link ResetClock}.
 */
export function renderResets(clock: ResetClock, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const zone = formatUtcOffsetLabel(clock.offsetMinutes);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(b("reset clock") + d(` (${basisPhrase(clock)}, ${zone})`));

  if (clock.total === 0) {
    lines.push(`  ${NO_RESETS_MESSAGE}`);
    if (clock.unparseable > 0) {
      lines.push(d(`  ${clock.unparseable} detection(s) had an unparseable timestamp and were skipped.`));
    }
    return lines.join("\n");
  }

  const max = clock.busiestCount;
  for (const { hour, count } of clock.hours) {
    // Scale each bar to the busiest hour; guarantee at least one block for any
    // non-zero hour so small counts don't vanish next to a spike.
    const filled = max === 0 || count === 0 ? 0 : Math.max(1, Math.round((count / max) * CLOCK_BAR_WIDTH));
    const plain = count === 0 ? "·" : "█".repeat(filled);
    const padded = plain.padEnd(CLOCK_BAR_WIDTH);
    const shown = count === 0 && color ? padded.replace("·", d("·")) : padded;
    // Star the modal hour so the busiest window is obvious at a glance.
    const marker = hour === clock.busiestHour ? b("←") : " ";
    lines.push(`  ${String(hour).padStart(2, "0")}:00  ${shown} ${count} ${marker}`);
  }

  const hourLabel = `${String(clock.busiestHour).padStart(2, "0")}:00`;
  const footerParts = [`busiest hour ${b(hourLabel)} (${clock.busiestCount})`, `${clock.total} detection(s), ${zone}`];
  if (clock.unparseable > 0) footerParts.push(`${clock.unparseable} unparseable skipped`);
  lines.push(d(`  ${footerParts.join(" · ")}`));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full clock — the 24
 * hour buckets plus the modal hour, totals, and unparseable count.
 */
export function renderResetsJson(input: {
  storePath: string;
  generatedAt?: string;
  scope?: Record<string, unknown>;
  clock: ResetClock;
}): string {
  return JSON.stringify(
    {
      storePath: input.storePath,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      scope: input.scope,
      clock: input.clock,
    },
    null,
    2
  );
}
