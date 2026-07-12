// Shared with the dashboard via @agentrelay/core so every entry point
// resolves the same store file.
export { defaultStorePath } from "@agentrelay/core";

export function resolveProjectName(cwd: string): string {
  // Last path segment is good enough for a human-readable project label.
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}
