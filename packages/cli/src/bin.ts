#!/usr/bin/env node
import { buildCli } from "./cli.js";
import { applyConfigFile } from "./config.js";

// Layer the optional config file under process.env BEFORE building the CLI, so
// `--store` defaults and every `*FromEnv()` call see the resolved values. A
// real env var still wins over the file. A malformed config aborts loudly.
try {
  applyConfigFile();
} catch (err) {
  console.error(`[agentrelay] ${(err as Error).message}`);
  process.exit(1);
}

buildCli()
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
