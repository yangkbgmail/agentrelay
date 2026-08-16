import { parseDuration } from "./prune.js";

/**
 * Resume grace — a small buffer the scheduler waits *after* a job's scheduled
 * resume time before actually re-running it.
 *
 * AgentRelay resumes a job the moment its rate-limit reset time passes. But
 * "the moment it passes" is a knife's edge: the reset time the agent reported
 * came from the *server's* clock, and the machine running the relay has its own
 * clock skew. Servers also tend to round reset boundaries to the nearest minute
 * or bucket, so a message saying "resets at 15:00:00" can still reject a request
 * that lands at 15:00:00.4. Resuming exactly on the boundary therefore risks an
 * *immediate* re-limit — which burns a retry attempt (and, once the attempt cap
 * is hit, can fail a job that would have succeeded a few seconds later).
 *
 * The grace closes that gap: with `AGENTRELAY_RESUME_GRACE=30s`, the scheduler
 * treats a job as due only once its reset time is at least 30 seconds in the
 * past, trading a tiny, bounded extra wait for a much lower chance of wasting an
 * attempt on the boundary. It defaults to `0` (the historical resume-on-the-dot
 * behavior) so nothing changes unless a user opts in.
 *
 * This module is the *pure* half — the env var name, the normalization rule, and
 * the cutoff computation. The scheduler consults {@link resumeCutoff} when
 * selecting due jobs; the CLI reads the env with {@link resumeGraceMsFromEnv}.
 */

/** Environment variable that sets the resume grace, as a duration (`30s`, `2m`). */
export const RESUME_GRACE_ENV = "AGENTRELAY_RESUME_GRACE";

/** Default grace: `0` ms — resume as soon as the reset time passes (historical). */
export const DEFAULT_RESUME_GRACE_MS = 0;

/**
 * Coerce an arbitrary grace value into a safe non-negative whole-ms number.
 * `undefined`/`null`, non-finite, and non-positive inputs all collapse to
 * {@link DEFAULT_RESUME_GRACE_MS} (grace off) so a bad value can never *advance*
 * a resume ahead of its scheduled time. Fractional ms are floored. Pure.
 */
export function normalizeResumeGraceMs(value: number | undefined | null): number {
  if (value === undefined || value === null) return DEFAULT_RESUME_GRACE_MS;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_RESUME_GRACE_MS;
  return Math.floor(value);
}

/**
 * Read the resume grace from the environment as a duration string. Missing,
 * blank, unparseable, or non-positive values yield {@link DEFAULT_RESUME_GRACE_MS}
 * (grace off) — a typo silently disables grace rather than accidentally delaying
 * every resume by a garbage amount. Pure aside from reading `env`.
 */
export function resumeGraceMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RESUME_GRACE_ENV];
  if (raw === undefined) return DEFAULT_RESUME_GRACE_MS;
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_RESUME_GRACE_MS;
  const ms = parseDuration(trimmed);
  return normalizeResumeGraceMs(ms);
}

/**
 * The effective "is it due yet?" reference time: `referenceTime` shifted back by
 * the (normalized) grace, so a job whose reset time is `t` is only considered due
 * once `now >= t + grace`. With grace `0` this returns `referenceTime` unchanged,
 * so the default path allocates nothing and behaves exactly as before. Pure.
 */
export function resumeCutoff(referenceTime: Date, graceMs: number): Date {
  const grace = normalizeResumeGraceMs(graceMs);
  return grace === 0 ? referenceTime : new Date(referenceTime.getTime() - grace);
}
