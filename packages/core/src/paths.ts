import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Expands a leading `~` (or `~/…`) to the user's home directory. Users naturally
 * write `~/.agentrelay/jobs.json` in a config file or `AGENTRELAY_STORE`, but the
 * shell only expands `~` for unquoted arguments — inside a JSON string it stays
 * literal and would otherwise create a directory literally named `~`. Anything
 * that isn't a leading `~` is returned unchanged. An explicit `home` may be
 * passed for deterministic tests.
 */
export function expandTilde(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** Store location shared by the CLI and the dashboard: env override or ~/.agentrelay/jobs.json. */
export function defaultStorePath(env: Record<string, string | undefined> = process.env): string {
  const override = env.AGENTRELAY_STORE;
  return override ? expandTilde(override) : join(homedir(), ".agentrelay", "jobs.json");
}
