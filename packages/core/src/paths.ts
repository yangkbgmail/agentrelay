import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Expands a leading `~` (or `~/…`) to the user's home directory. The shell does
 * this for command-line args, but a path coming from the config *file* never
 * passes through a shell, so `store: "~/.agentrelay/jobs.json"` would otherwise
 * be taken literally and create a bogus `~` directory. A bare `~` and `~/rest`
 * are expanded; a `~user` form is left untouched (we can't resolve it).
 */
export function expandTilde(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** Store location shared by the CLI and the dashboard: env override or ~/.agentrelay/jobs.json. */
export function defaultStorePath(env: Record<string, string | undefined> = process.env): string {
  const override = env.AGENTRELAY_STORE;
  if (override) return expandTilde(override);
  return join(homedir(), ".agentrelay", "jobs.json");
}
