// Pure line helpers for `agentrelay tail <id>` — extracting just the captured
// output of a job (its `lastOutputTail`) so it can be piped to grep/less
// without the surrounding `show` detail chrome. Kept free of I/O and clock so
// the slicing logic is unit-testable on its own; the CLI (commands.ts/cli.ts)
// owns store access and rendering.

/**
 * Return the last `n` lines of `text`. A non-positive or omitted `n` returns
 * the whole text unchanged. `null`/`undefined`/empty text yields an empty
 * string. Lines are split on `"\n"`; a trailing newline therefore yields a
 * trailing empty line that is preserved, so the returned text stays
 * byte-faithful to what the agent actually printed.
 */
export function tailLines(text: string | null | undefined, n?: number): string {
  if (!text) return "";
  if (n === undefined || n <= 0) return text;
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return lines.slice(-n).join("\n");
}

/**
 * Count the number of `"\n"`-separated lines in `text` (0 for
 * `null`/`undefined`/empty). Matches the segmentation `tailLines` uses, so a
 * trailing newline counts as a final empty line — the natural denominator when
 * slicing a tail by line.
 */
export function countLines(text: string | null | undefined): number {
  if (!text) return 0;
  return text.split("\n").length;
}
