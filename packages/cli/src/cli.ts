import type {
  AgentTool,
  CompletionCommandSpec,
  CompletionShell,
  CompletionSpec,
  ExportFormat,
  GroupDimension,
  JobScope,
  JobStatus,
  RelayJob,
} from "@agentrelay/core";
import {
  ALL_TOOLS,
  COMPLETION_SHELLS,
  computeDailyTrend,
  computeStats,
  EXPORT_FORMATS,
  GROUP_DIMENSIONS,
  generateCompletion,
  groupStats,
  isCompletionShell,
  isJobScopeActive,
  parseDuration,
  SETTABLE_CONFIG_KEYS,
  scopeJobs,
  selectNextResume,
  sendTestNotification,
} from "@agentrelay/core";
import { Command } from "commander";
import {
  ALL_JOB_STATUSES,
  type BulkControlAction,
  type BulkControlResult,
  backupStore,
  bulkControlJobs,
  cancelJob,
  exportStore,
  initConfig,
  type JobControlResult,
  listStatus,
  listStoreBackups,
  previewRestoreStore,
  pruneJobs,
  restoreStore,
  retryJob,
  runCommand,
  runDoctor,
  setConfigFile,
  showConfig,
  showJob,
  startDaemon,
  tickOnce,
  unsetConfigFile,
  validateConfigFile,
} from "./commands.js";
import { defaultStorePath, renderEffectiveConfig, renderEffectiveConfigJson } from "./config.js";
import { renderDoctor, renderDoctorJson } from "./doctor.js";
import { renderNext, renderNextJson } from "./next.js";
import { renderTestNotifyResults, renderTestNotifyResultsJson } from "./notify.js";
import { buildParseReport, renderParseReport, renderParseReportJson } from "./parse.js";
import { renderJobDetail, renderJobDetailJson } from "./show.js";
import { renderGroupedStats, renderGroupedStatsJson, renderStats, renderStatsJson, renderTrend } from "./stats.js";
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

/** The `--status`/`--tool`/`--project`/`--since`/`--until` filter options. */
interface ScopeOpts {
  status?: string;
  tool?: string;
  project?: string;
  since?: string;
  until?: string;
}

type ScopeBuild = { scope: JobScope; note: string; active: boolean } | { error: string };

/**
 * Build a core {@link JobScope} from the shared `--status`/`--tool`/`--project`/
 * `--since`/`--until` filter options, validating each and returning a single
 * `{ error }` on the first bad value. `--since`/`--until` are "N ago" durations
 * relative to `now`, so `--since 7d --until 1d` scopes to jobs created between 7
 * and 1 days ago. Keeps the bulk `cancel`/`retry` commands in step with how
 * `stats`/`status`/`export` interpret the same flags.
 */
function buildScope(opts: ScopeOpts, now: number): ScopeBuild {
  const scope: JobScope = {};
  const noteParts: string[] = [];

  if (opts.status !== undefined) {
    const requested = splitList(opts.status);
    const invalid = requested.filter((s) => !ALL_JOB_STATUSES.includes(s as JobStatus));
    if (invalid.length > 0) {
      return { error: `Unknown status(es): ${invalid.join(", ")}. Valid: ${ALL_JOB_STATUSES.join(", ")}.` };
    }
    scope.statuses = requested as JobStatus[];
    noteParts.push(`status=${requested.join(",")}`);
  }

  if (opts.tool !== undefined) {
    const requested = splitList(opts.tool);
    const invalid = requested.filter((t) => !ALL_TOOLS.includes(t as AgentTool));
    if (invalid.length > 0) {
      return { error: `Unknown tool(s): ${invalid.join(", ")}. Valid: ${ALL_TOOLS.join(", ")}.` };
    }
    scope.tools = requested;
    noteParts.push(`tool=${requested.join(",")}`);
  }

  if (opts.project !== undefined) {
    const requested = splitList(opts.project);
    if (requested.length === 0) return { error: "--project needs at least one project name." };
    scope.projects = requested;
    noteParts.push(`project=${requested.join(",")}`);
  }

  if (opts.since !== undefined) {
    const ms = parseDuration(opts.since);
    if (ms === null) return { error: `Invalid --since duration: "${opts.since}". Use e.g. 24h, 7d, 30m, 90s.` };
    scope.createdFrom = now - ms;
    noteParts.push(`since=${opts.since}`);
  }

  if (opts.until !== undefined) {
    const ms = parseDuration(opts.until);
    if (ms === null) return { error: `Invalid --until duration: "${opts.until}". Use e.g. 24h, 7d, 30m, 90s.` };
    scope.createdTo = now - ms;
    noteParts.push(`until=${opts.until}`);
  }

  if (scope.createdFrom !== undefined && scope.createdTo !== undefined && scope.createdFrom > scope.createdTo) {
    return { error: "--since must be a longer window than --until (empty range otherwise)." };
  }

  return { scope, note: noteParts.join(" "), active: isJobScopeActive(scope) };
}

/** Static config for a `cancel`/`retry` command registered by {@link registerBulkControl}. */
interface BulkControlSpec {
  name: string;
  action: BulkControlAction;
  /** The existing single-id handler, used when no `--all` is given. */
  single: (idOrPrefix: string, storePath?: string) => JobControlResult;
  describe: string;
  allHelp: string;
}

/** Print a bulk cancel/retry result: one line per affected job, then a summary. */
function printBulkResult(result: BulkControlResult, note: string): void {
  for (const job of result.affected) {
    console.log(`  ${job.id.slice(0, 8)}  ${job.project}  (${job.status})`);
  }
  const scopeLine = note ? ` [scope: ${note}]` : "";
  const suffix = result.dryRun ? " — no changes made" : "";
  console.log(`[agentrelay] ${result.message}${suffix}${scopeLine}`);
}

/**
 * Register a `cancel` or `retry` command that acts on a single job by id, or —
 * with `--all` plus the shared scope filters — on every matching job at once.
 * Both paths share the same core guards, so bulk and single-id behaviour stay
 * consistent. `--all` and an explicit id are mutually exclusive.
 */
function registerBulkControl(program: Command, spec: BulkControlSpec): void {
  program
    .command(spec.name)
    .description(spec.describe)
    .argument("[id]", "Job id or a short id prefix (see `agentrelay status`); omit when using --all")
    .option("--all", spec.allHelp)
    .option("-s, --status <statuses>", "Only jobs with these statuses (comma-separated)")
    .option("-t, --tool <tools>", "Only jobs run with these tools (comma-separated)")
    .option("-p, --project <projects>", "Only jobs in these projects (comma-separated)")
    .option("--since <duration>", "Only jobs created within this long ago (e.g. 24h, 7d)")
    .option("--until <duration>", "Only jobs created before this long ago (e.g. 1d)")
    .option("--dry-run", "Preview which jobs would be affected without changing the store")
    .action((id: string | undefined, opts: ScopeOpts & { all?: boolean; dryRun?: boolean }) => {
      const { store } = program.opts();

      if (!opts.all) {
        if (!id) {
          console.error(`Provide a job id, or --all to ${spec.action} matching jobs.`);
          process.exitCode = 1;
          return;
        }
        const result = spec.single(id, store);
        console.log(`[agentrelay] ${result.message}`);
        if (!result.ok) process.exitCode = 1;
        return;
      }

      if (id) {
        console.error("Pass either a job id or --all, not both.");
        process.exitCode = 1;
        return;
      }

      const built = buildScope(opts, Date.now());
      if ("error" in built) {
        console.error(built.error);
        process.exitCode = 1;
        return;
      }

      const result = bulkControlJobs(spec.action, { scope: built.scope, dryRun: opts.dryRun, storePath: store });
      printBulkResult(result, built.note);
    });
}

/**
 * Read all of stdin as a UTF-8 string. Used by `agentrelay parse` when no
 * message argument is given so users can pipe an agent's output straight in
 * (`claude ... | agentrelay parse`). Resolves with "" if stdin is empty.
 */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/**
 * Collect the flag tokens (long and short) a commander command accepts, so the
 * completion script can offer them. Order: each option's long form then short
 * form, in declaration order; deduped by the generator.
 */
function collectFlags(cmd: Command): string[] {
  const flags: string[] = [];
  for (const opt of cmd.options) {
    if (opt.long) flags.push(opt.long);
    if (opt.short) flags.push(opt.short);
  }
  return flags;
}

/**
 * Derive a shell-completion spec from the live commander program, so the
 * completion script always matches the real command surface (no hand-kept
 * duplicate list to drift). Walks one level of nesting for parent commands like
 * `config` that group subcommands.
 */
export function buildCompletionSpec(program: Command): CompletionSpec {
  const commands: CompletionCommandSpec[] = program.commands.map((cmd) => {
    const entry: CompletionCommandSpec = { name: cmd.name(), options: collectFlags(cmd) };
    if (cmd.commands.length > 0) {
      entry.subcommands = cmd.commands.map(
        (sub): CompletionCommandSpec => ({ name: sub.name(), options: collectFlags(sub) })
      );
    }
    return entry;
  });
  return { program: program.name(), options: collectFlags(program), commands };
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
function runWatch(store: string, intervalMs: number, selection: JobSelection, window?: JobScope, limit?: number): void {
  const draw = () => {
    const all = listStatus(store);
    const windowed = window && isJobScopeActive(window) ? scopeJobs(all, window) : all;
    const selected = selectJobs(windowed, selection);
    const frame = renderWatchFrame(selected, store, intervalMs, Date.now(), limit);
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
    .option("-n, --limit <n>", "Show at most N jobs (applied after filter/sort; the summary still counts all matches)")
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
        limit?: string;
      }) => {
        const { store } = program.opts();

        const selection: JobSelection = { reverse: opts.reverse };

        let limit: number | undefined;
        if (opts.limit !== undefined) {
          const n = Number.parseInt(opts.limit, 10);
          if (!Number.isInteger(n) || n < 1) {
            console.error(`Invalid --limit value "${opts.limit}". Use a positive integer.`);
            process.exitCode = 1;
            return;
          }
          limit = n;
        }

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
          console.log(renderStatusJson(selectJobs(scoped(listStatus(store)), selection), store, undefined, limit));
          return;
        }

        if (opts.watch !== undefined) {
          const parsed = typeof opts.watch === "string" ? Number.parseFloat(opts.watch) : NaN;
          const intervalMs = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 1000) : 2000;
          runWatch(store, intervalMs, selection, window, limit);
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
        console.log(renderStatusTable(selected, { color: Boolean(process.stdout.isTTY), limit }));
      }
    );

  program
    .command("next")
    .description("Show the single job the relay will resume next and how long until it's due")
    .option("--json", "Print as JSON (machine-readable, for scripts/jq)")
    .option(
      "--exit-code",
      "Reflect state in the exit code (0 = a job is due now, 3 = pending but not yet due, 4 = nothing waiting)"
    )
    .action((opts: { json?: boolean; exitCode?: boolean }) => {
      const { store } = program.opts();
      const next = selectNextResume(listStatus(store));

      if (opts.json) {
        console.log(renderNextJson(next, store));
      } else {
        console.log(renderNext(next, { color: Boolean(process.stdout.isTTY) }));
      }

      // Opt-in exit codes let scripts branch without jq: e.g. a cron that only
      // pokes the relay when something is actually due (`agentrelay next
      // --exit-code && agentrelay tick`).
      if (opts.exitCode) {
        if (next === null) process.exitCode = 4;
        else if (!next.due) process.exitCode = 3;
        // due-now → exit 0 (default).
      }
    });

  program
    .command("stats")
    .description("Show aggregate relay metrics: success rate, retries, per-tool/per-project breakdown")
    .option("-s, --status <statuses>", "Only count jobs with these comma-separated statuses (e.g. completed,failed)")
    .option("-t, --tool <tools>", `Only count jobs run with these comma-separated tools: ${ALL_TOOLS.join(", ")}`)
    .option("-p, --project <projects>", "Only count jobs from these comma-separated project names (exact match)")
    .option("--since <duration>", "Only count jobs created within the last <duration> (e.g. 24h, 7d, 30m)")
    .option("--until <duration>", "Only count jobs created more than <duration> ago (e.g. 1d) — window's older edge")
    .option("-g, --group-by <dimension>", `Break down metrics per group: ${GROUP_DIMENSIONS.join(", ")}`)
    .option("--trend [days]", "Also show a per-day activity histogram over the last N days, UTC (default 14, max 90)")
    .option("--json", "Print the stats as JSON (machine-readable, for scripts/jq)")
    .action(
      (opts: {
        status?: string;
        tool?: string;
        project?: string;
        since?: string;
        until?: string;
        groupBy?: string;
        trend?: string | boolean;
        json?: boolean;
      }) => {
        const { store } = program.opts();

        const now = Date.now();
        const scope: JobScope = {};
        const noteParts: string[] = [];

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

        let groupBy: GroupDimension | undefined;
        if (opts.groupBy !== undefined) {
          if (!GROUP_DIMENSIONS.includes(opts.groupBy as GroupDimension)) {
            console.error(`Unknown --group-by: "${opts.groupBy}". Valid: ${GROUP_DIMENSIONS.join(", ")}.`);
            process.exitCode = 1;
            return;
          }
          groupBy = opts.groupBy as GroupDimension;
        }

        // --trend is an optional-value flag: bare `--trend` uses the default
        // window, `--trend 30` overrides it. Reject non-positive/huge/garbage.
        let trendDays: number | null = null;
        if (opts.trend !== undefined && opts.trend !== false) {
          if (opts.trend === true) {
            trendDays = 14;
          } else {
            const parsed = Number(opts.trend);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90) {
              console.error(`Invalid --trend value: "${opts.trend}". Use a whole number of days from 1 to 90.`);
              process.exitCode = 1;
              return;
            }
            trendDays = parsed;
          }
        }

        const allJobs = listStatus(store);
        const active = isJobScopeActive(scope);
        const jobs = active ? scopeJobs(allJobs, scope) : allJobs;
        const scopeNote = active ? noteParts.join(" ") : undefined;

        if (groupBy !== undefined) {
          const groups = groupStats(jobs, groupBy);
          if (opts.json) {
            console.log(renderGroupedStatsJson(groups, groupBy, store, { scope }));
            return;
          }
          console.log(renderGroupedStats(groups, groupBy, { color: Boolean(process.stdout.isTTY), scopeNote }));
          return;
        }

        const stats = computeStats(jobs);
        const trend = trendDays !== null ? computeDailyTrend(jobs, { nowMs: now, days: trendDays }) : null;

        if (opts.json) {
          console.log(renderStatsJson(stats, store, { scope, trend }));
          return;
        }
        // A store with jobs but an empty scoped subset should say "no match",
        // not the onboarding hint — renderStats keys that off scopeNote.
        console.log(renderStats(stats, { color: Boolean(process.stdout.isTTY), scopeNote }));
        // Append the histogram only when the store has matching jobs (renderStats
        // already handles the empty/no-match messaging on its own).
        if (trend !== null && stats.total > 0) {
          console.log("");
          console.log(renderTrend(trend, { color: Boolean(process.stdout.isTTY) }));
        }
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

  const notify = program.command("notify").description("Inspect and test notification channels (Slack/webhook)");
  notify
    .command("test")
    .description("Send a test notification to every configured channel to verify delivery works end-to-end")
    .option("--json", "Print the results as JSON (machine-readable, for scripts/CI)")
    .option("--show-secrets", "Reveal masked destination URLs in the human-readable output")
    .action(async (opts: { json?: boolean; showSecrets?: boolean }) => {
      const results = await sendTestNotification();
      if (opts.json) {
        console.log(renderTestNotifyResultsJson(results));
      } else {
        console.log(
          renderTestNotifyResults(results, { color: Boolean(process.stdout.isTTY), showSecrets: opts.showSecrets })
        );
      }
      // Exit non-zero when nothing was configured (nothing to test) or any
      // channel failed, so scripts/CI can gate on working notifications.
      if (results.length === 0 || results.some((r) => !r.ok)) process.exitCode = 1;
    });

  program
    .command("export")
    .description("Export the job store to CSV, JSON, Markdown, or NDJSON for spreadsheets/BI/jq/issues (stdout or a file)")
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

  program
    .command("parse")
    .description(
      "Test the rate-limit parser against a message: see if AgentRelay would detect a limit, which pattern matched, and when it would resume"
    )
    .argument("[text...]", "Message to parse; if omitted, read from stdin (e.g. pipe your agent's output)")
    .option("-t, --tool <tool>", `Use one tool's adapter patterns before the generic ones: ${ALL_TOOLS.join(", ")}`)
    .option("--json", "Print the result as JSON (machine-readable, for scripts/jq)")
    .action(async (textParts: string[], opts: { tool?: string; json?: boolean }) => {
      let text = (textParts ?? []).join(" ");
      if (!text) {
        if (process.stdin.isTTY) {
          console.error("[agentrelay] No message given. Pass text as an argument or pipe it via stdin.");
          process.exitCode = 1;
          return;
        }
        text = await readStdin();
      }
      const tool = opts.tool;
      if (tool !== undefined && !ALL_TOOLS.includes(tool as AgentTool)) {
        console.error(`Unknown tool: ${tool}. Valid: ${ALL_TOOLS.join(", ")}.`);
        process.exitCode = 1;
        return;
      }
      const report = buildParseReport(text, { tool: tool as AgentTool | undefined });
      if (opts.json) {
        console.log(renderParseReportJson(report));
        return;
      }
      console.log(renderParseReport(report, { color: Boolean(process.stdout.isTTY) }));
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
  config
    .command("set")
    .description("Set a single value in agentrelay.config.json (creates the file if needed)")
    .argument("<key>", `Dotted config key, one of: ${SETTABLE_CONFIG_KEYS.join(", ")}`)
    .argument("<value>", "New value (coerced to the field's type)")
    .action((key: string, value: string) => {
      const { config: configPath } = program.opts();
      const result = setConfigFile({ key, value, path: configPath });
      if (result.ok) {
        console.log(`[agentrelay] ${result.message}`);
      } else {
        console.error(`[agentrelay] ${result.message}`);
        process.exitCode = 1;
      }
    });
  config
    .command("unset")
    .description("Remove a single value from agentrelay.config.json so its default applies again")
    .argument("<key>", `Dotted config key to remove, one of: ${SETTABLE_CONFIG_KEYS.join(", ")}`)
    .action((key: string) => {
      const { config: configPath } = program.opts();
      const result = unsetConfigFile({ key, path: configPath });
      if (result.ok) {
        console.log(`[agentrelay] ${result.message}`);
      } else {
        console.error(`[agentrelay] ${result.message}`);
        process.exitCode = 1;
      }
    });

  registerBulkControl(program, {
    name: "cancel",
    action: "cancel",
    single: cancelJob,
    describe: "Cancel a pending job (by id), or every matching job with --all",
    allHelp: "Cancel every matching pending job (narrow with the scope filters below)",
  });

  registerBulkControl(program, {
    name: "retry",
    action: "retry",
    single: retryJob,
    describe: "Requeue a job to resume immediately (by id), or every matching job with --all",
    allHelp: "Requeue every matching job to resume now (narrow with the scope filters below)",
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

  program
    .command("completion")
    .description("Print a shell completion script for agentrelay (bash or zsh)")
    .argument("<shell>", `Shell to generate completion for: ${COMPLETION_SHELLS.join(" | ")}`)
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  # bash: source it now, or add the line to ~/.bashrc\n" +
        "  source <(agentrelay completion bash)\n" +
        "  # zsh: write it onto your $fpath, then restart your shell\n" +
        "  agentrelay completion zsh > ~/.zfunc/_agentrelay"
    )
    .action((shell: string) => {
      if (!isCompletionShell(shell)) {
        console.error(`Unknown shell "${shell}". Valid: ${COMPLETION_SHELLS.join(", ")}.`);
        process.exitCode = 1;
        return;
      }
      const spec = buildCompletionSpec(program);
      process.stdout.write(generateCompletion(shell as CompletionShell, spec));
    });

  return program;
}
