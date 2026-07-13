import { Command } from "commander";
import type { RetryPolicy } from "@agentrelay/core";
import { defaultStorePath } from "./config.js";
import { listStatus, runCommand, startDaemon, tickOnce } from "./commands.js";

interface RetryCliOpts {
  maxAttempts?: string;
  baseBackoff?: string;
  maxBackoff?: string;
  backoffFactor?: string;
}

/** Turns raw string CLI flags into a partial RetryPolicy, dropping unset ones. */
function parseRetryOpts(opts: RetryCliOpts): Partial<RetryPolicy> {
  const retry: Partial<RetryPolicy> = {};
  if (opts.maxAttempts !== undefined) retry.maxAttempts = parseInt(opts.maxAttempts, 10);
  if (opts.baseBackoff !== undefined) retry.baseBackoffMs = parseInt(opts.baseBackoff, 10) * 1000;
  if (opts.maxBackoff !== undefined) retry.maxBackoffMs = parseInt(opts.maxBackoff, 10) * 1000;
  if (opts.backoffFactor !== undefined) retry.backoffFactor = parseFloat(opts.backoffFactor);
  return retry;
}

function withRetryFlags(cmd: Command): Command {
  return cmd
    .option("--max-attempts <n>", "Max resume attempts before marking a job failed (0 = unlimited)")
    .option("--base-backoff <seconds>", "Initial backoff (seconds) after a real failure")
    .option("--max-backoff <seconds>", "Maximum backoff (seconds) between retries")
    .option("--backoff-factor <n>", "Exponential backoff multiplier per attempt");
}

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
    .argument("<command...>", "Command to run, e.g. agentrelay run -- claude -p \"continue\"")
    .action(async (command: string[]) => {
      const { store } = program.opts();
      const result = await runCommand({ command, storePath: store });
      process.exitCode = result.exitCode;
    });

  withRetryFlags(
    program
      .command("daemon")
      .description("Poll the job queue and auto-resume jobs once their rate limit resets")
      .option("-i, --interval <ms>", "Poll interval in milliseconds", "30000")
  ).action((opts: { interval: string } & RetryCliOpts) => {
    const { store } = program.opts();
    startDaemon({
      storePath: store,
      pollIntervalMs: parseInt(opts.interval, 10),
      retry: parseRetryOpts(opts),
    });
    // Keep the process alive; RelayScheduler uses setInterval internally.
  });

  withRetryFlags(
    program
      .command("tick")
      .description("Run a single scheduler pass immediately (useful when driven by external cron/Routines)")
  ).action(async (opts: RetryCliOpts) => {
    const { store } = program.opts();
    const processed = await tickOnce(store, undefined, parseRetryOpts(opts));
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

  return program;
}
