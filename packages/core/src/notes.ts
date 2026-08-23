/**
 * Job notes — a short, free-form human annotation attached to a relay job.
 *
 * A queued job is identified in the `status` table only by an 8-char id and its
 * (auto-derived) project name, which makes a large queue hard to scan: "which
 * of these three `myapp` jobs was the nightly refactor?" A note lets a human
 * label a job at enqueue time (`agentrelay run --note "nightly refactor" …`) or
 * after the fact (`agentrelay note <id> "…"`) so `show`/`export` can answer that
 * question. Notes are pure metadata: they never affect scheduling, parsing, or
 * lifecycle timestamps.
 *
 * This module is the single place note text is normalized, so every entry point
 * (run, the `note` command, any future import path) stores notes identically.
 */

/**
 * Maximum stored length of a job note. Notes are a scanning aid, not a log —
 * a pasted wall of text would bloat the JSON store and wreck the `show` layout,
 * so anything longer is hard-capped (truncated, not rejected: a too-long note
 * is better trimmed than dropped).
 */
export const MAX_NOTE_LENGTH = 280;

/**
 * Normalize a user-supplied note into its stored form:
 * - `null`/`undefined` → `null` (no note).
 * - Surrounding whitespace is trimmed; an empty/whitespace-only value collapses
 *   to `null`, so `--note ""` and `agentrelay note <id>` (no text) both *clear*
 *   the note rather than storing a blank one.
 * - Interior newlines/tabs collapse to single spaces so a note stays a
 *   single-line label (multi-line prose belongs in the command, not the note).
 * - The result is hard-capped at {@link MAX_NOTE_LENGTH} characters.
 *
 * Pure: text in, normalized text (or `null`) out.
 */
export function normalizeNote(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed === "") return null;
  return collapsed.length > MAX_NOTE_LENGTH ? collapsed.slice(0, MAX_NOTE_LENGTH) : collapsed;
}
