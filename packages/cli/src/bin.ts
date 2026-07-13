#!/usr/bin/env node
import { buildCli } from "./cli.js";

buildCli()
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
