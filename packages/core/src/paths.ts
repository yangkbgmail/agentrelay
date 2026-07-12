import { homedir } from "node:os";
import { join } from "node:path";

/** Store location shared by the CLI and the dashboard: env override or ~/.agentrelay/jobs.json. */
export function defaultStorePath(env: Record<string, string | undefined> = process.env): string {
  return env.AGENTRELAY_STORE ?? join(homedir(), ".agentrelay", "jobs.json");
}
