#!/usr/bin/env node
import { buildCli } from "./cli.js";
import { bootstrapConfig } from "./config.js";

// Load agentrelay.config.json (if any) into process.env *before* building the
// CLI, so config-file defaults feed the same env-driven options as always while
// explicit env/CLI values still win. A malformed config throws here and is
// reported by the catch below.
try {
  bootstrapConfig();
} catch (err) {
  console.error(String(err));
  process.exit(1);
}

buildCli()
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
