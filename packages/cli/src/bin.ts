#!/usr/bin/env node
import { buildCli } from "./cli.js";
import { bootstrapConfig, isConfigDiagnosticInvocation } from "./config.js";

// Load agentrelay.config.json (if any) into process.env *before* building the
// CLI, so config-file defaults feed the same env-driven options as always while
// explicit env/CLI values still win. A malformed config throws here and is
// reported by the catch below — except for the `config validate`/`config show`
// diagnostics, whose whole job is to inspect config resolution, so we let them
// run instead of aborting at startup (and, for `show`, keep the file's values
// out of process.env so precedence stays attributable).
if (!isConfigDiagnosticInvocation()) {
  try {
    bootstrapConfig();
  } catch (err) {
    console.error(String(err));
    process.exit(1);
  }
}

buildCli()
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
