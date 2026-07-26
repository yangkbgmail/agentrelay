import { parseDuration } from "./prune.js";

/**
 * Default resume safety buffer. `0` keeps the historical behavior: a job is due
 * the instant its parsed reset time passes, with no extra wait. Opt in via
 * `AGENTRELAY_RESUME_BUFFER` / `resume.buffer` when you want a margin.
 */
export const DEFAULT_RESUME_BUFFER_MS = 0;

/**
 * A small fixed delay added *after* a job's rate-limit reset time before the
 * scheduler considers it due to resume.
 *
 * Why this exists: the reset time AgentRelay parses out of an agent's output is
 * frequently optimistic — providers round it, and the local clock can drift
 * ahead of the provider's. Resuming at the exact reported reset therefore often
 * re-hits the limit immediately, burning a whole attempt (and, with a capped
 * `maxAttempts`, potentially failing a job that just needed a few more seconds).
 * A buffer trades a little extra idle time for far fewer wasted resumes.
 *
 * The stored `resetAt` is left untouched (it stays the truthful, provider-
 * reported reset that `show`/`next`/the dashboard display); the buffer is applied
 * only where the scheduler decides what's due — see {@link RelayQueue.listDue}.
 *
 * Reads `AGENTRELAY_RESUME_BUFFER` as a human duration (`30s`, `2m`, `500ms`, …).
 * Unset, empty, unparseable, or negative values fall back to
 * {@link DEFAULT_RESUME_BUFFER_MS} (0) — a typo can never *shorten* the wait, at
 * worst it disables the buffer.
 */
export function resumeBufferMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENTRELAY_RESUME_BUFFER;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RESUME_BUFFER_MS;
  const ms = parseDuration(raw.trim());
  if (ms === null || ms < 0) return DEFAULT_RESUME_BUFFER_MS;
  return ms;
}
