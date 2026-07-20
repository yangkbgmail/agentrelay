import type { AgentTool, ExportFormat, GroupDimension, JobScope, JobStatus, RelayJob } from "@agentrelay/core";
import {
  ALL_TOOLS,
  computeStats,
  EXPORT_FORMATS,
  GROUP_DIMENSIONS,
  groupStats,
  isJobScopeActive,
  parseDuration,
  scopeJobs,
} from "@agentrelay/core";
import { Command } from "commander";
import {
  ALL_JOB_STATUSES,
  backupStore,
  cancelJob,
  exportStore,
  initConfig,
  listStatus,
  listStoreBackups,
  previewRestoreStore,
  pruneJobs,
  restoreStore,
  retryJob,
  runCommand,
  runDoctor,
  showConfig,
  showJob,
  startDaemon,
  tickOnce,
  validateConfigFile,
} from "./commands.js";
import { defaultStorePath, renderEffectiveConfig, renderEffectiveConfigJson } from "./config.js";
import { renderDoctor, renderDoctorJson } from "./doctor.js";
import { renderJobDetail, renderJobDetailJson } from "./show.js";
import { renderStatGroups, renderStatGroupsJson, renderStats, renderStatsJson } from "./stats.js";
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
 * Split a comma-separated CLI option (e.g. `--status completed,failed`) into
 * trimmed, non-empty tokens. Shared by the `--status`/`--tool`/`--project`
 * filters so they all treat whitespace and stray commas the same way.
 */
function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Live `agentrelay status --watch`: clears the screen and re-renders the table
 * on an interval so countdowns tick down in place. `listStatus` re-reads the
 * JSON store each pass, so a running daemon's writes show up automatically.
 * The same `--status`/`--tool`/`--project`/`--sort`/`--reverse` selection and
 * the `--since`/`--until` time window are re-applied every pass. The window
 * boundaries are absolute epoch-ms (fixed when the command started), so live
 * writes still show up while the window edges stay put.
 * Runs until the process is interrupted (Ctrl-C).
 */
function runWatch(store: string, intervalMs: number, selection: JobSelection, window?: JobScope): void {
  const draw = () => {
    const all = listStatus(store);
    const windowed = window && isJobScopeActive(window) ? scopeJobs(all, window) : all;
    const selected = selectJobs(windowed, selection);
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
    .option("-t, --tool <tools>", `Only show jobs run with these comma-separated tools: ${ALL_TOOLS.join(", ")}`)
    .option("-p, --project <projects>", "Only show jobs from these comma-separated project names (exact match)")
    .option("--since <duration>", "Only show jobs created within the last <duration> (e.g. 24h, 7d, 30m)")
    .option("--until <duration>", "Only show jobs created more than <duration> ago (e.g. 1d) — window's older edge")
    .option("--sort <field>", `Sort by one of: ${SORT_FIELDS.join(", ")} (default: newest first)`)
    .option("-r, --reverse", "Reverse the order (flips --sort, or the store order when no --sort)")
    .action(
      (opts: {
        watch?: string | boolean;
        json?: boolean;
        status?: string;
        tool?: string;
        project?: string;
        since?: string;
        until?: string;
        sort?: string;
        reverse?: boolean;
      }) => {
        const { store } = program.opts();

        const selection: JobSelection = { reverse: opts.reverse };

        if (opts.status !== undefined) {
          const requested = splitList(opts.status);
          const invalid = requested.filter((s) => !ALL_JOB_STATUSES.includes(s as JobStatus));
          if (invalid.length > 0) {
            console.error(`Unknown status(es): ${invalid.join(", ")}. Valid: ${ALL_JOB_STATUSES.join(", ")}.`);
            process.exitCode = 1;
            return;
          }
          selection.statuses = requested as JobStatus[];
        }

        if (opts.tool !== undefined) {
          const requested = splitList(opts.tool);
          const invalid = requested.filter((t) => !ALL_TOOLS.includes(t as AgentTool));
          if (invalid.length > 0) {
            console.error(`Unknown tool(s): ${invalid.join(", ")}. Valid: ${ALL_TOOLS.join(", ")}.`);
            process.exitCode = 1;
            return;
          }
          selection.tools = requested;
        }

        if (opts.project !== undefined) {
          const requested = splitList(opts.project);
          if (requested.length === 0) {
            console.error("--project needs at least one project name.");
            process.exitCode = 1;
            return;
          }
          selection.projects = requested;
        }

        if (opts.sort !== undefined) {
          if (!SORT_FIELDS.includes(opts.sort as SortField)) {
            console.error(`Unknown --sort field "${opts.sort}". Valid: ${SORT_FIELDS.join(", ")}.`);
            process.exitCode = 1;
            return;
          }
          selection.sort = opts.sort as SortField;
        }

        // Time window: --since/--until are "N ago" durations relative to now, so
        // `--since 7d --until 1d` scopes to jobs created between 7 and 1 days ago.
        // Applied via core scopeJobs before selectJobs, matching stats/export.
        const now = Date.now();
        const window: JobScope = {};
        if (opts.since !== undefined) {
          const ms = parseDuration(opts.since);
          if (ms === null) {
            console.error(`Invalid --since duration: "${opts.since}". Use e.g. 24h, 7d, 30m, 90s.`);
            process.exitCode = 1;
            return;
          }
          window.createdFrom = now - ms;
        }
        if (opts.until !== undefined) {
          const ms = parseDuration(opts.until);
          if (ms === null) {
            console.error(`Invalid --until duration: "${opts.until}". Use e.g. 24h, 7d, 30m, 90s.`);
            process.exitCode = 1;
            return;
          }
          window.createdTo = now - ms;
        }
        if (
          window.createdFrom !== undefined &&
          window.createdTo !== undefined &&
          window.createdFrom > window.createdTo
        ) {
          console.error("--since must be a longer window than --until (empty range otherwise).");
          process.exitCode = 1;
          return;
        }
        const scoped = (jobs: RelayJob[]): RelayJob[] => (isJobScopeActive(window) ? scopeJobs(jobs, window) : jobs);

        if (opts.json) {
          console.log(renderStatusJson(selectJobs(scoped(listStatus(store)), selection), store));
          return;
        }

        if (opts.watch !== undefined) {
          const parsed = typeof opts.watch === "string" ? Number.parseFloat(opts.watch) : NaN;
          const intervalMs = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 1000) : 2000;
          runWatch(store, intervalMs, selection, window);
          return; // setInterval keeps the process alive.
        }

        const all = listStatus(store);
        const selected = selectJobs(scoped(all), selection);
        // Distinguish "store is empty" from "filter matched nothing" so the
        // hint to run a command doesn't show up when jobs simply got filtered out.
        if (selected.length === 0 && all.length > 0) {
          console.log(NO_MATCH_MESSAGE);
          return;
        }
        console.log(renderStatusTable(selected, { color: Boolean(process.stdout.isTTY) }));
      }
    );

  program
    .command("stats")
    .description("Show aggregate relay metrics: success rate, retries, per-tool/per-project breakdown")
    .option("-s, --status <statuses>", "Only count jobs with these comma-separated statuses (e.g. completed,failed)")
    .option("-t, --tool <tools>", `Only count jobs run with these comma-separated tools: ${ALL_TOOLS.join(", ")}`)
    .option("-p, --project <projects>", "Only count jobs from these comma-separated project names (exact match)")
    .option("--since <duration>", "Only count jobs created within the last <duration> (e.g. 24h, 7d, 30m)")
    .option("--until <duration>", "Only count jobs created more than <duration> ago (e.g. 1d) — window's older edge")
    .option(
      "-g, --group-by <dimension>",
      `Break metrics down per group instead of one aggregate: ${GROUP_DIMENSIONS.join(", ")}`
    )
    .option("--json", "Print the stats as JSON (machine-readable, for scripts/jq)")
    .action(
      (opts: {
        status?: string;
        tool?: string;
        project?: string;
        since?: string;
        until?: string;
        groupBy?: string;
        json?: boolean;
      }) => {
        const { store } = program.opts();

        const now = Date.now();
        const scope: JobScope = {};
        const noteParts: string[] = [];

        let dimension: GroupDimension | undefined;
        if (opts.groupBy !== undefined) {
          if (!GROUP_DIMENSIONS.includes(opts.groupBy as GroupDimension)) {
            console.error(`Unknown --group-by dimension: "${opts.groupBy}". Valid: ${GROUP_DIMENSIONS.join(", ")}.`);
            process.exitCode = 1;
            return;
          }
          dimension = opts.groupBy as GroupDimension;
        }

        if (opts.status !== undefined) {
          const requested = splitList(opts.status);
          const invalid = requested.filter((s) => !ALL_JOB_STATUSES.includes(s as JobStatus));
          if (invalid.length > 0) {
            console.error(`Unknown status(es): ${invalid.join(", ")}. Valid: ${ALL_JOB_STATUSES.join(", ")}.`);
            process.exitCode = 1;
            return;
          }
          scope.statuses = requested as JobStatus[];
          noteParts.push(`status=${requested.join(",")}`);
        }

        if (opts.tool !== undefined) {
          const requested = splitList(opts.tool);
          const invalid = requested.filter((t) => !ALL_TOOLS.includes(t as AgentTool));
          if (invalid.length > 0) {
            console.error(`Unknown tool(s): ${invalid.join(", ")}. Valid: ${ALL_TOOLS.join(", ")}.`);
            process.exitCode = 1;
            return;
          }
          scope.tools = requested;
          noteParts.push(`tool=${requested.join(",")}`);
        }

        if (opts.project !== undefined) {
          const requested = splitList(opts.project);
          if (requested.length === 0) {
            console.error("--project needs at least one project name.");
            process.exitCode = 1;
            return;
          }
          scope.projects = requested;
          noteParts.push(`project=${requested.join(",")}`);
        }

        // Time window: --since/--until are "N ago" durations relative to now, so
        // `--since 7d --until 1d` scopes to jobs created between 7 and 1 days ago.
        if (opts.since !== undefined) {
          const ms = parseDuration(opts.since);
          if (ms === null) {
            console.error(`Invalid --since duration: "${opts.since}". Use e.g. 24h, 7d, 30m, 90s.`);
            process.exitCode = 1;
            return;
          }
          scope.createdFrom = now - ms;
          noteParts.push(`since=${opts.since}`);
        }

        if (opts.until !== undefined) {
          const ms = parseDuration(opts.until);
          if (ms === null) {
            console.error(`Invalid --until duration: "${opts.until}". Use e.g. 24h, 7d, 30m, 90s.`);
            process.exitCode = 1;
            return;
          }
          scope.createdTo = now - ms;
          noteParts.push(`until=${opts.until}`);
        }

        if (scope.createdFrom !== undefined && scope.createdTo !== undefined && scope.createdFrom > scope.createdTo) {
          console.error("--since must be a longer window than --until (empty range otherwise).");
          process.exitCode = 1;
          return;
        }

        const allJobs = listStatus(store);
        const active = isJobScopeActive(scope);
        const jobs = active ? scopeJobs(allJobs, scope) : allJobs;
        const scopeNote = active ? noteParts.join(" ") : undefined;

        // --group-by trades the single aggregate block for a per-group table so
        // you can compare success rates/resolution times across tools/projects.
        if (dimension) {
          const groups = groupStats(jobs, dimension);
          if (opts.json) {
            console.log(renderStatGroupsJson(groups, dimension, store, { scope }));
            return;
          }
          console.log(renderStatGroups(groups, dimension, { color: Boolean(process.stdout.isTTY), scopeNote }));
          return;
        }

        const stats = computeStats(jobs);

        if (opts.json) {
          console.log(renderStatsJson(stats, store, { scope }));
          return;
        }
        // A store with jobs but an empty scoped subset should say "no match",
        // not the onboarding hint — renderStats keys that off scopeNote.
        console.log(renderStats(stats, { color: Boolean(process.stdout.isTTY), scopeNote }));
      }
    );

  program
    .command("doctor")
    .description("Health-check your setup: Node version, job store, config file, and notifications")
    .option("--json", "Print the diagnostics as JSON (machine-readable, for scripts/CI)")
    .action((opts: { json?: boolean }) => {
      const { store, config: configPath } = program.opts();
      const report = runDoctor({ storePath: store, configPath });
      if (opts.json) {
        console.log(renderDoctorJson(report));
      } else {
        console.log(renderDoctor(report, { color: Boolean(process.stdout.isTTY) }));
      }
      // Exit non-zero when any check failed, so `agentrelay doctor` is usable as
      // a CI/pre-flight gate.
      if (!report.ok) process.exitCode = 1;
    });

  program
    .command("export")
    .description("Export the job store to CSV or JSON for spreadsheets/BI/jq (stdout or a file)")
    .option("-f, --format <format>", `Output format: ${EXPORT_FORMATS.join(" | ")}`, "csv")
    .option("-o, --out <file>", "Write to this file instead of stdout")
    .option("-s, --status <statuses>", "Only export jobs with these comma-separated statuses (e.g. completed,failed)")
    .option("-t, --tool <tools>", `Only export jobs run with these comma-separated tools: ${ALL_TOOLS.join(", ")}`)
    .option("-p, --project <projects>", "Only export jobs from these comma-separated project names (exact match)")
    .option("--since <duration>", "Only export jobs created within the last <duration> (e.g. 24h, 7d, 30m)")
    .option("--until <duration>", "Only export jobs created more than <duration> ago (e.g. 1d) — window's older edge")
    .option("--sort <field>", `Sort by one of: ${SORT_FIELDS.join(", ")} (default: newest first)`)
    .option("-r, --reverse", "Reverse the order (flips --sort, or the store order when no --sort)")
    .action(
      (opts: {
        format?: string;
        out?: string;
        status?: string;
        tool?: string;
        project?: string;
        since?: string;
        until?: string;
        sort?: string;
        reverse?: boolean;
      }) => {
        const { store } = program.opts();

        const format = (opts.format ?? "csv").toLowerCase();
        if (!EXPORT_FORMATS.includes(format as ExportFormat)) {
          console.error(`Unknown --format "${opts.format}". Valid: ${EXPORT_FORMATS.join(", ")}.`);
          process.exitCode = 1;
          return;
        }

        // status/tool/project/sort/reverse go through selectJobs (which also sorts);
        // the --since/--until time window uses core scopeJobs, applied first.
        const selection: JobSelection = { reverse: opts.reverse };

        if (opts.status !== undefined) {
          const requested = splitList(opts.status);
          const invalid = requested.filter((s) => !ALL_JOB_STATUSES.includes(s as JobStatus));
          if (invalid.length > 0) {
            console.error(`Unknown status(es): ${invalid.join(", ")}. Valid: ${ALL_JOB_STATUSES.join(", ")}.`);
            process.exitCode = 1;
            return;
          }
          selection.statuses = requested as JobStatus[];
        }

        if (opts.tool !== undefined) {
          const requested = splitList(opts.tool);
          const invalid = requested.filter((t) => !ALL_TOOLS.includes(t as AgentTool));
          if (invalid.length > 0) {
            console.error(`Unknown tool(s): ${invalid.join(", ")}. Valid: ${ALL_TOOLS.join(", ")}.`);
            process.exitCode = 1;
            return;
          }
          selection.tools = requested;
        }

        if (opts.project !== undefined) {
          const requested = splitList(opts.project);
          if (requested.length === 0) {
            console.error("--project needs at least one project name.");
            process.exitCode = 1;
            return;
          }
          selection.projects = requested;
        }

        if (opts.sort !== undefined) {
          if (!SORT_FIELDS.includes(opts.sort as SortField)) {
            console.error(`Unknown --sort field "${opts.sort}". Valid: ${SORT_FIELDS.join(", ")}.`);
            process.exitCode = 1;
            return;
          }
          selection.sort = opts.sort as SortField;
        }

        // Time window: --since/--until are "N ago" durations relative to now, so
        // `--since 7d --until 1d` scopes to jobs created between 7 and 1 days ago.
        const now = Date.now();
        const window: JobScope = {};
        if (opts.since !== undefined) {
          const ms = parseDuration(opts.since);
          if (ms === null) {
            console.error(`Invalid --since duration: "${opts.since}". Use e.g. 24h, 7d, 30m, 90s.`);
            process.exitCode = 1;
            return;
          }
          window.createdFrom = now - ms;
        }
        if (opts.until !== undefined) {
          const ms = parseDuration(opts.until);
          if (ms === null) {
            console.error(`Invalid --until duration: "${opts.until}". Use e.g. 24h, 7d, 30m, 90s.`);
            process.exitCode = 1;
            return;
          }
          window.createdTo = now - ms;
        }
        if (
          window.createdFrom !== undefined &&
          window.createdTo !== undefined &&
          window.createdFrom > window.createdTo
        ) {
          console.error("--since must be a longer window than --until (empty range otherwise).");
          process.exitCode = 1;
          return;
        }

        const all = listStatus(store);
        const windowed = isJobScopeActive(window) ? scopeJobs(all, window) : all;
        const jobs = selectJobs(windowed, selection);
        const result = exportStore({ storePath: store, format: format as ExportFormat, jobs, outPath: opts.out });
        if (result.writtenTo) {
          // Keep stdout clean for redirection; status goes to stderr.
          console.error(`[agentrelay] exported ${result.count} job(s) to ${result.writtenTo}`);
        } else {
          console.log(result.content);
        }
      }
    );

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
  config
    .command("show")
    .description("Show the effective configuration and where each value comes from (env > file > default)")
    .option("--json", "Print the resolved config as JSON (machine-readable, for scripts/jq)")
    .option("--show-secrets", "Reveal masked webhook URLs/tokens in the human-readable output")
    .action((opts: { json?: boolean; showSecrets?: boolean }) => {
      const { config: configPath } = program.opts();
      const result = showConfig({ path: configPath });
      if (opts.json) {
        console.log(renderEffectiveConfigJson(result));
      } else {
        console.log(
          renderEffectiveConfig(result, { color: Boolean(process.stdout.isTTY), showSecrets: opts.showSecrets })
        );
      }
      // A broken config file is a real problem worth a non-zero exit, but we
      // still printed the env/default resolution above to aid debugging.
      if (result.loadError) process.exitCode = 1;
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
    .command("backup")
    .description("Write a timestamped snapshot of the job store and rotate old ones")
    .option("--keep <n>", "How many recent snapshots to keep after this one (default: 10)")
    .option("--list", "List existing snapshots instead of creating one")
    .action((opts: { keep?: string; list?: boolean }) => {
      const { store } = program.opts();

      if (opts.list) {
        const backups = listStoreBackups(store);
        if (backups.length === 0) {
          console.log(`No snapshots found for ${store}.`);
          return;
        }
        console.log(`${backups.length} snapshot(s) for ${store} (newest first):`);
        for (const b of backups) {
          console.log(`  ${b.path}`);
        }
        return;
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

      const result = backupStore({ storePath: store, keepLast });
      console.log(`[agentrelay] Wrote snapshot of ${result.jobCount} job(s) to ${result.path}.`);
      if (result.rotated.length > 0) {
        console.log(`[agentrelay] Rotated out ${result.rotated.length} old snapshot(s).`);
      }
    });

  program
    .command("restore")
    .argument("[snapshot]", 'Snapshot to restore: "latest" (default), a stamp, a snapshot filename, or a path')
    .description("Restore the job store from a snapshot (the current store is backed up first)")
    .option("--no-backup", "Skip snapshotting the current store before overwriting it")
    .option("--dry-run", "Show what would be restored without changing the store")
    .action((snapshot: string | undefined, opts: { backup?: boolean; dryRun?: boolean }) => {
      const { store } = program.opts();
      try {
        if (opts.dryRun) {
          const preview = previewRestoreStore({
            storePath: store,
            selector: snapshot ?? "latest",
            backupCurrent: opts.backup,
          });
          console.log(
            `[agentrelay] Dry run: would restore ${preview.jobCount} job(s) from ${preview.from}, ` +
              `replacing the current ${preview.currentJobCount} job(s).`
          );
          console.log(
            preview.wouldBackUp
              ? "[agentrelay] The current store would be backed up first."
              : "[agentrelay] The current store would NOT be backed up."
          );
          console.log("[agentrelay] No changes made (--dry-run).");
          return;
        }
        const result = restoreStore({
          storePath: store,
          selector: snapshot ?? "latest",
          backupCurrent: opts.backup,
        });
        console.log(`[agentrelay] Restored ${result.jobCount} job(s) from ${result.from}.`);
        if (result.backedUpTo) {
          console.log(`[agentrelay] Previous store backed up to ${result.backedUpTo}.`);
        }
      } catch (error) {
        console.error(`[agentrelay] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
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
