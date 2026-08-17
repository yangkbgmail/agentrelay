import type { QueueSummary } from "@agentrelay/core";

/**
 * The document title shown when nothing needs watching — a fresh load, an empty
 * queue, or a queue whose jobs are all in a terminal state.
 */
export const BASE_TITLE = "AgentRelay Dashboard";

/**
 * Build the browser-tab title from the current queue summary.
 *
 * A local dashboard is usually left open in a *background* tab while you work in
 * the agent CLI — so the one place a glance is cheapest is the tab title itself.
 * We surface the count of jobs still in flight (`resuming` + `waiting_for_reset`)
 * as a leading `(N)` badge, the same unread-count convention every mail/chat app
 * uses, so a pinned or backgrounded tab reads "how much is the relay still
 * juggling?" without switching to it.
 *
 * Only in-flight work counts: `completed`/`failed`/`cancelled` jobs are historical
 * (they sit in the store until pruned), so folding them into the badge would pin a
 * stale number to the tab forever. When nothing is in flight the title collapses
 * back to the bare {@link BASE_TITLE}, so an idle relay leaves a clean tab.
 *
 * Pure and summary-only (no clock): the badge changes on discrete status
 * transitions the poll picks up, never on the per-second countdown — so the title
 * doesn't flicker every tick. A missing summary (initial load) yields the base
 * title. Defensive against a partial `byStatus` (missing keys count as 0).
 */
export function buildPageTitle(summary: QueueSummary | undefined | null): string {
  if (!summary) return BASE_TITLE;
  const resuming = summary.byStatus?.resuming ?? 0;
  const waiting = summary.byStatus?.waiting_for_reset ?? 0;
  const inFlight = resuming + waiting;
  if (inFlight <= 0) return BASE_TITLE;
  return `(${inFlight}) ${BASE_TITLE}`;
}
