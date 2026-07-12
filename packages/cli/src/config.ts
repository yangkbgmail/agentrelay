import { homedir } from "node:os";
import { join } from "node:path";

export function defaultStorePath(): string {
  return process.env.AGENTRELAY_STORE ?? join(homedir(), ".agentrelay", "jobs.json");
}

export function resolveProjectName(cwd: string): string {
  // Last path segment is good enough for a human-readable project label.
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}
