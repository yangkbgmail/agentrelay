import type { AgentTool, JobStatus } from "@agentrelay/core";
import { computeStats, parseDuration } from "@agentrelay/core";
import { Command } from "commander";
import {
  ALL_JOB_STATUSES,
  cancelJob,
  initConfig,
  listStatus,
  pruneJobs,
  retryJob,
  runCommand,
  showJob,
  startDaemon,
  tickOnce,
  validateConfigFile,
} from "./commands.js";
import { defaultStorePath } from "./config.js";
import { renderJobDetail, renderJobDetailJson } from "./show.js";
import { renderStats, renderStatsJson } from "./stats.js";
import {
  type JobSelection,
  NO_MATCH_MESSAGE,
  renderStatusJson,
  renderStatusTable,
  renderWatchFrame,
  SORT_FIELDS,
  type SortField,
  selectJobs,
} from "./status.js";

/**
 * Live `agentrelay status --watch`: clears the screen and re-renders the table
 * on an interval so countdowns tick down in place. `listStatus` re-reads the
 * JSON store each pass, so a running daemon's writes show up automatically.
 * The same `--status`/`--sort`/`--reverse` selection is re-applied every pass.
 * Runs until the process is interrupted (Ctrl-C).
 */
function runWatch(store: string, intervalMs: number, selection: JobSelection): void {
  const draw = () => {
    const selected = selectJobs(listStatus(store), selection);
    const frame = renderWatchFrame(selected, store, intervalMs);
    // Clear screen + move cursor home, then paint the frame.
    process.stdout.write(`\x1b[2J\x1b[H${frame}\n`);
  };
  draw();
  const timer = setInterval(draw, intervalMs);
  const stop = () => {
    clearInterval(timer);
    process.stdout.write("\n");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

export function buildCli(): Command {
  const program = new Command();
  program
    .name("agentrelay")
    .description(
      "Wrap AI coding agent CLI calls (Claude Code, etc.), detect rate-limit messages, and auto-resume once the limit resets."
    )
    .version("0.1.0")
    .option("--store <path>", "Path to the job store JSON file", defaultStorePath())
    .option(
      "--config <path>",
      "Path to an agentrelay.config.json (else ./agentrelay.config.json or ~/.agentrelay/config.json). Config values are defaults; explicit env/CLI values win."
    );

  program
    .command("run")
    .description("Run a command, watching its output for rate-limit messages")
    .argument("<command...>", 'Command to run, e.g. agentrelay run -- claude -p "continue"')
    .option(
      "--tool <tool>",
      "Agent tool adapter to use (claude-code | codex-cli | generic). Inferred from the command when omitted."
    )
    .action(async (command: string[], opts: { tool?: string }) => {
      const { store } = program.opts();
      const result = await runCommand({
        command,
        storePath: store,
        tool: opts.tool as AgentTool | undefined,
      });
      process.exitCode = result.exitCode;
    });

  program
    .command("daemon")
    .description("Poll the job queue and auto-resume jobs once their rate limit resets")
    .option("-i, --interval <ms>", "Poll interval in milliseconds", "30000")
    .action((opts: { interval: string }) => {
      const { store } = program.opts();
      startDaemon({ storePath: store, pollIntervalMs: parseInt(opts.interval, 10) });
      // Keep the process alive; RelayScheduler uses setInterval internally.
    });

  program
    .command("tick")
    .description("Run a single scheduler pass immediately (useful when driven by external cron/Routines)")
    .action(async () => {
      const { store } = program.opts();
      const processed = await tickOnce(store);
      if (processed.length === 0) {
        console.log("[agentrelay] no due jobs.");
      } else {
        for (const job of processed) {
          console.log(`[agentrelay] ${job.id} (${job.project}) -> ${job.status}`);
        }
      }
    });

  program
    .command("status")
    .description("List all jobs and their current state")
    .option("-w, --watch [seconds]", "Continuously refresh the view with live countdowns (Ctrl-C to exit)")
    .option("--json", "Print the status as JSON (machine-readable, for scripts/jq)")
    .option("-s, --status <statuses>", "Only show jobs with these comma-separated statuses (e.g. queued,failed)")
    .option("--sort <field>", `Sort by one of: ${SORT_FIELDS.join(", ")} (default: newest first)`)
    .option("-r, --reverse", "Reverse the order (flips --sort, or the store order when no --sort)")
    .action((opts: { watch?: string | boolean; json?: boolean; status?: string; sort?: string; reverse?: boolean }) => {
      const { store } = program.opts();

      const selection: JobSelection = { reverse: opts.reverse };

      if (opts.status !== undefined) {
        const requested = opts.status
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const invalid = requested.filter((s) => !ALL_JOB_STATUSES.includes(s as JobStatus));
        if (invalid.length > 0) {
          console.error(`Unknown status(es): ${invalid.join(", ")}. Valid: ${ALL_JOB_STATUSES.join(", ")}.`);
          process.exitCode = 1;
          return;
        }
        selection.statuses = requested as JobStatus[];
      }

      if (opts.sort !== undefined) {
        if (!SORT_FIELDS.includes(opts.sort as SortField)) {
          console.error(`Unknown --sort field "${opts.sort}". Valid: ${SORT_FIELDS.join(", ")}.`);
          process.exitCode = 1;
          return;
        }
        selection.sort = opts.sort as SortField;
      }

      if (opts.json) {
        console.log(renderStatusJson(selectJobs(listStatus(store), selection), store));
        return;
      }

      if (opts.watch !== undefined) {
        const parsed = typeof opts.watch === "string" ? Number.parseFloat(opts.watch) : NaN;
        const intervalMs = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 1000) : 2000;
        runWatch(store, intervalMs, selection);
        return; // setInterval keeps the process alive.
      }

      const all = listStatus(store);
      const selected = selectJobs(all, selection);
      // Distinguish "store is empty" from "filter matched nothing" so the
      // hint to run a command doesn't show up when jobs simply got filtered out.
      if (selected.length === 0 && all.length > 0) {
        console.log(NO_MATCH_MESSAGE);
        return;
      }
      console.log(renderStatusTable(selected, { color: Boolean(process.stdout.isTTY) }));
    });

  program
    .command("stats")
    .description("Show aggregate relay metrics: success rate, retries, per-tool/per-project breakdown")
    .option("--json", "Print the stats as JSON (machine-readable, for scripts/jq)")
    .action((opts: { json?: boolean }) => {
      const { store } = program.opts();
      const stats = computeStats(listStatus(store));
      if (opts.json) {
        console.log(renderStatsJson(stats, store));
        return;
      }
      console.log(renderStats(stats, { color: Boolean(process.stdout.isTTY) }));
    });

  program
    .command("show")
    .description("Show full details for one job: command, cwd, timestamps, last error, and captured output")
    .argument("<id>", "Job id or a short id prefix (see `agentrelay status`)")
    .option("--json", "Print the job as JSON (machine-readable, for scripts/jq)")
    .action((id: string, opts: { json?: boolean }) => {
      const { store } = program.opts();
      const result = showJob(id, store);
      if (!result.ok || !result.job) {
        console.error(`[agentrelay] ${result.error ?? "job not found"}`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(renderJobDetailJson(result.job, store));
        return;
      }
      console.log(renderJobDetail(result.job, { color: Boolean(process.stdout.isTTY) }));
    });

  const config = program.command("config").description("Manage the agentrelay.config.json defaults file");
  config
    .command("init")
    .description("Write a documented sample agentrelay.config.json to start from")
    .argument("[path]", "Where to write the file (default: ./agentrelay.config.json)")
    .option("-f, --force", "Overwrite an existing config file")
    .action((path: string | undefined, opts: { force?: boolean }) => {
      const result = initConfig({ path, force: opts.force });
      if (result.ok) {
        console.log(`[agentrelay] ${result.message}`);
      } else {
        console.error(`[agentrelay] ${result.message}`);
        process.exitCode = 1;
      }
    });
  config
    .command("validate")
    .description("Check an agentrelay.config.json for structural and semantic mistakes")
    .argument(
      "[path]",
      "Config file to check (default: discovered ./agentrelay.config.json or ~/.agentrelay/config.json)"
    )
    .action((path: string | undefined) => {
      const result = validateConfigFile({ path });
      const where = result.path ?? "config";
      if (result.issues.length === 0) {
        console.log(`[agentrelay] ${where} is valid.`);
        return;
      }
      for (const issue of result.issues) {
        const line = `[agentrelay] ${issue.level}: ${issue.path} ${issue.message}`;
        if (issue.level === "error") console.error(line);
        else console.warn(line);
      }
      if (!result.ok) {
        console.error(`[agentrelay] ${where} has errors.`);
        process.exitCode = 1;
      } else {
        console.log(`[agentrelay] ${where} is valid (with warnings).`);
      }
    });

  program
    .command("cancel")
    .description("Cancel a pending job so the scheduler stops relaying it")
    .argument("<id>", "Job id or a short id prefix (see `agentrelay status`)")
    .action((id: string) => {
      const { store } = program.opts();
      const result = cancelJob(id, store);
      console.log(`[agentrelay] ${result.message}`);
      if (!result.ok) process.exitCode = 1;
    });

  program
    .command("retry")
    .description("Requeue a job to resume immediately (fresh attempt count)")
    .argument("<id>", "Job id or a short id prefix (see `agentrelay status`)")
    .action((id: string) => {
      const { store } = program.opts();
      const result = retryJob(id, store);
      console.log(`[agentrelay] ${result.message}`);
      if (!result.ok) process.exitCode = 1;
    });

  program
    .command("prune")
    .description("Remove old finished jobs (completed/failed) from the store to keep it small")
    .option("--older-than <duration>", "Only prune jobs untouched for at least this long (e.g. 7d, 24h, 30m)")
    .option("--status <statuses>", "Comma-separated statuses to prune (default: completed,failed)")
    .option("--keep <n>", "Always keep the N most recently updated eligible jobs")
    .option("--dry-run", "Show what would be pruned without deleting anything")
    .action((opts: { olderThan?: string; status?: string; keep?: string; dryRun?: boolean }) => {
      const { store } = program.opts();

      let olderThanMs: number | undefined;
      if (opts.olderThan !== undefined) {
        const parsed = parseDuration(opts.olderThan);
        if (parsed === null) {
          console.error(`Invalid --older-than value "${opts.olderThan}". Use a duration like 7d, 24h, 30m, 90s.`);
          process.exitCode = 1;
          return;
        }
        olderThanMs = parsed;
      }

      let statuses: JobStatus[] | undefined;
      if (opts.status !== undefined) {
        const requested = opts.status
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const invalid = requested.filter((s) => !ALL_JOB_STATUSES.includes(s as JobStatus));
        if (invalid.length > 0) {
          console.error(`Unknown status(es): ${invalid.join(", ")}. Valid: ${ALL_JOB_STATUSES.join(", ")}.`);
          process.exitCode = 1;
          return;
        }
        statuses = requested as JobStatus[];
      }

      let keepLast: number | undefined;
      if (opts.keep !== undefined) {
        const n = Number.parseInt(opts.keep, 10);
        if (!Number.isInteger(n) || n < 0) {
          console.error(`Invalid --keep value "${opts.keep}". Use a non-negative integer.`);
          process.exitCode = 1;
          return;
        }
        keepLast = n;
      }

      const { pruned, remaining } = pruneJobs({
        storePath: store,
        olderThanMs,
        statuses,
        keepLast,
        dryRun: opts.dryRun,
      });

      const verb = opts.dryRun ? "Would prune" : "Pruned";
      if (pruned.length === 0) {
        console.log(`Nothing to prune. ${remaining} job(s) remain.`);
        return;
      }
      for (const job of pruned) {
        console.log(
          `${opts.dryRun ? "-" : "×"} ${job.id.slice(0, 8)}  ${job.project.slice(0, 20).padEnd(20)} ${job.status}`
        );
      }
      console.log(`${verb} ${pruned.length} job(s). ${remaining} remain.`);
    });

  return program;
}
