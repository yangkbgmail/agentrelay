/**
 * Bounded output buffer for wrapped agent processes.
 *
 * Both the scheduler (when it resumes a queued job) and `agentrelay run` (when
 * it wraps the first invocation) need to buffer combined stdout/stderr so the
 * rate-limit parser can scan it after the child exits. The old, obvious way was
 * to write `output += chunk.toString()` on each `data` event and slice at the
 * end. That works for tidy commands but is a real memory hazard for the kind
 * of agents this tool exists for: a Claude Code or Codex CLI session can emit
 * megabytes (occasionally gigabytes) of streaming tokens before hitting a rate
 * limit. Accumulating all of it into one string in the relay daemon can OOM
 * the process — the exact opposite of the "never let the loop die" contract
 * the rest of the codebase (heartbeat / doctor / recover / notifier retries)
 * defends. The parser only ever needs the *tail* anyway, and the persisted
 * `lastOutputTail` on the job is also bounded, so streaming through a ring
 * buffer preserves every parser guarantee at bounded memory cost.
 *
 * The buffer is intentionally pure and clock-free: caller feeds chunks, buffer
 * decides how much to keep, no filesystem, no I/O. Empty/whitespace input is
 * handled the same as any other input — the length policy is the only policy.
 *
 * `maxChars` counts UTF-16 code units (i.e. `String.prototype.length`), which
 * matches the way the rest of the codebase measures `lastOutputTail`. That
 * means a stream of astral-plane emoji can weigh up to 2 bytes per "char"
 * in the tail budget; that's fine — the goal is a bound, not exact bytes.
 */

/**
 * Default character cap for the resume output tail. Chosen to comfortably fit
 * a Claude Code / Codex CLI rate-limit banner plus a page or two of preceding
 * context (a few hundred lines of typical output), while staying tiny on disk
 * once persisted as `lastOutputTail`. Historically the scheduler used 2000; we
 * keep the same default so existing tails and tests don't shift.
 */
export const DEFAULT_OUTPUT_TAIL_LENGTH = 2000;

/**
 * Bounded output tail. `append(chunk)` returns the *current* tail so callers
 * that only ever want the freshest snapshot don't need to also call
 * `snapshot()`; `snapshot()` is provided for symmetry with buffered readers.
 * When `maxChars <= 0` the buffer stores nothing (some callers legitimately
 * want to disable buffering entirely) but still tolerates append().
 */
export interface OutputTail {
  append(chunk: string): string;
  snapshot(): string;
  readonly maxChars: number;
}

/**
 * Create a bounded output tail that keeps at most `maxChars` characters
 * (the *last* `maxChars` characters of everything appended so far).
 *
 * Implementation is a single mutable string that's re-sliced on each append.
 * That's O(chunk + maxChars) per append, which is what the naive `output +=`
 * pattern also is — the win is that the string never grows past `maxChars`
 * regardless of how much streams through, so the daemon's RSS stays bounded.
 *
 * Non-finite / negative `maxChars` collapse to a zero-length buffer, so a
 * caller that misconfigures the size still gets a functioning (silent)
 * buffer instead of a crash: the relay loop must never be brought down by
 * an output-buffer misconfiguration.
 */
export function createOutputTail(maxChars: number = DEFAULT_OUTPUT_TAIL_LENGTH): OutputTail {
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0;
  let buffer = "";
  return {
    get maxChars() {
      return cap;
    },
    append(chunk: string): string {
      if (cap === 0) return buffer; // buffering disabled; nothing to keep
      // Fast path: incoming chunk alone already exceeds the cap. No need to
      // touch the existing buffer — the new tail is entirely from `chunk`.
      if (chunk.length >= cap) {
        buffer = chunk.slice(chunk.length - cap);
        return buffer;
      }
      buffer = buffer.length + chunk.length <= cap ? buffer + chunk : (buffer + chunk).slice(-cap);
      return buffer;
    },
    snapshot(): string {
      return buffer;
    },
  };
}

/**
 * Parse a user-supplied string into a bounded output-tail length. Returns
 * `defaultValue` (which itself defaults to {@link DEFAULT_OUTPUT_TAIL_LENGTH})
 * for undefined, empty, whitespace, non-numeric, non-finite, or negative
 * input. That "typo = default, don't silently disable" policy matches
 * {@link parseDuration} etc. and prevents an unintended `-1` or `abc` from
 * quietly turning the buffer off (which would kill rate-limit detection on
 * resume — a much worse failure mode than an unbounded buffer).
 *
 * `0` is accepted verbatim and disables buffering intentionally; callers who
 * want that (e.g. tests exercising the disabled path) can opt in explicitly.
 * Decimals floor toward zero so `"2000.9"` reads as `2000`, not a fraction.
 */
export function parseOutputTailLength(
  input: string | number | undefined | null,
  options: { defaultValue?: number } = {}
): number {
  const fallback = options.defaultValue ?? DEFAULT_OUTPUT_TAIL_LENGTH;
  if (input === undefined || input === null) return fallback;
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) return fallback;
    return Math.floor(input);
  }
  const trimmed = input.trim();
  if (trimmed === "") return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Read {@link parseOutputTailLength} from `AGENTRELAY_OUTPUT_TAIL`. Missing
 * or malformed values fall back to {@link DEFAULT_OUTPUT_TAIL_LENGTH} — a
 * typo in the env var must not silently shrink or disable the tail (which
 * would break rate-limit detection on resume). Reads from `process.env` by
 * default; a custom map can be injected for tests.
 */
export function outputTailLengthFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return parseOutputTailLength(env.AGENTRELAY_OUTPUT_TAIL);
}
