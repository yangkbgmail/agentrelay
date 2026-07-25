/**
 * Bounded-concurrency helpers for the resume loop.
 *
 * By default the scheduler resumes due jobs strictly one at a time (a serial
 * `for` loop). That's the safest behavior — each resume spawns a full agent
 * CLI run — but when many jobs share the same rate-limit reset time (a "resume
 * herd": every job in a project becomes due the instant the window reopens),
 * processing them one-by-one can make draining the backlog take far longer than
 * it needs to. Allowing a small, opt-in amount of concurrency lets that herd
 * drain in parallel while still capping how many agent processes run at once.
 *
 * This is safe against the JSON store precisely because every {@link RelayQueue}
 * mutation is fully synchronous (load → mutate → atomic flush, with no `await`
 * in between): concurrent `resume()` calls can only interleave at their `await`
 * boundaries (notify / spawn), never in the middle of a store write, and each
 * mutation re-reads the latest on-disk state before flushing the whole map —
 * so there are no lost updates even with several resumes in flight.
 */

/** Serial resume — identical to the historical for-loop. Also the safe default. */
export const DEFAULT_MAX_CONCURRENT = 1;

/**
 * Clamp a requested concurrency to a positive integer, falling back to
 * {@link DEFAULT_MAX_CONCURRENT} for anything unusable (undefined, NaN,
 * Infinity, zero, or negative). Fractional values floor (2.9 → 2). Keeping this
 * pure and separate makes the parsing rules unit-testable without a scheduler.
 */
export function normalizeMaxConcurrent(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_CONCURRENT;
  const n = Math.floor(value);
  return n >= 1 ? n : DEFAULT_MAX_CONCURRENT;
}

/**
 * Read `AGENTRELAY_MAX_CONCURRENT` from the environment. Unset, blank,
 * non-numeric, or non-positive values fall back to serial ({@link
 * DEFAULT_MAX_CONCURRENT}) so a typo never silently spins up an unbounded
 * number of agent processes — it just keeps the safe one-at-a-time behavior.
 */
export function maxConcurrentFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENTRELAY_MAX_CONCURRENT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_CONCURRENT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MAX_CONCURRENT;
  return normalizeMaxConcurrent(n);
}

/**
 * Run `worker` over `items` with at most `limit` invocations in flight at once,
 * preserving result order: `results[i]` always corresponds to `items[i]`,
 * regardless of the order workers finish in.
 *
 * `limit <= 1` runs strictly sequentially and awaits each worker before the
 * next — byte-for-byte the same behavior (and same ordering) as the historical
 * serial loop, so the default path is unchanged. Higher limits start that many
 * runners, each pulling the next index off a shared cursor until the list is
 * exhausted.
 *
 * Note: this does not catch worker rejections — a throwing worker rejects the
 * returned promise, matching the serial loop. Callers whose worker already
 * resolves to a result (as the scheduler's `resume` does) never hit that path.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const n = items.length;
  const results = new Array<R>(n);
  if (n === 0) return results;

  const effective = normalizeMaxConcurrent(limit);
  if (effective <= 1) {
    for (let i = 0; i < n; i++) {
      results[i] = await worker(items[i], i);
    }
    return results;
  }

  let next = 0;
  const runnerCount = Math.min(effective, n);
  const runners: Promise<void>[] = [];
  for (let r = 0; r < runnerCount; r++) {
    runners.push(
      (async () => {
        while (true) {
          const i = next++;
          if (i >= n) return;
          results[i] = await worker(items[i], i);
        }
      })()
    );
  }
  await Promise.all(runners);
  return results;
}
