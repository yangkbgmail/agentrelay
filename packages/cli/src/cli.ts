import type { AgentTool, JobStatus } from "@agentrelay/core";
import { parseDuration } from "@agentrelay/core";
import { Command } from "commander";
import {
  ALL_JOB_STATUSES,
  cancelJob,
  listStatus,
  pruneJobs,
  retryJob,
  runCommand,
  startDaemon,
  tickOnce,
} from "./commands.js";
import { defaultStorePath } from "./config.js";

function formatCountdown(resetAt: string | null): string {
  if (!resetAt) return "-";
  const ms = new Date(resetAt).getTime() - Date.now();
  if (ms <= 0) return "due now";
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function buildCli(): Command {
  const program = new Command();
  program
    .name("agentrelay")
    .description(
      "Wrap AI coding agent CLI calls (Claude Code, etc.), detect rate-limit messages, and auto-resume once the limit resets."
    )
    .version("0.1.0")
    .option("--store <path>", "Path to the job store JSON file", defaultStorePath());

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
    .action(() => {
      const { store } = program.opts();
      const jobs = listStatus(store);
      if (jobs.length === 0) {
        console.log("No jobs yet. Run `agentrelay run -- <your agent command>` to get started.");
        return;
      }
      console.log(
        ["ID".padEnd(10), "PROJECT".padEnd(16), "STATUS".padEnd(18), "RESETS IN".padEnd(12), "ATTEMPTS"].join(" ")
      );
      for (const job of jobs) {
        console.log(
          [
            job.id.slice(0, 8).padEnd(10),
            job.project.slice(0, 16).padEnd(16),
            job.status.padEnd(18),
            formatCountdown(job.resetAt).padEnd(12),
            String(job.attempts),
          ].join(" ")
        );
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
