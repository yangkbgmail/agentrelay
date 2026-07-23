#!/usr/bin/env node
// AgentRelay end-to-end demo — a reproducible, self-contained walkthrough of the
// whole relay loop, with no real rate limit or waiting for a real reset window.
//
//   node scripts/demo.mjs            # run the demo (needs a prior `pnpm build`)
//   node scripts/demo.mjs --keep     # keep the temp store dir for inspection
//   node scripts/demo.mjs --quiet    # only print step headers and the verdict
//
// What it does, against a throwaway job store in an OS temp dir:
//   1. `agentrelay run` wraps a *fake* agent that prints a Claude-style
//      rate-limit message (reset a couple seconds out) and exits non-zero.
//      AgentRelay detects the limit and queues the job to resume.
//   2. `agentrelay status` / `next` show the job waiting with a countdown.
//   3. Once the (short) reset window passes, `agentrelay tick` resumes the job.
//      The fake agent now succeeds, so the job is marked completed.
//   4. `agentrelay status` / `stats` confirm exactly one completed job.
//
// The fake agent is deterministic: it counts its own invocations via a state
// file, fails the first time and succeeds after. Because this script spawns
// every step, the child processes inherit its env (DEMO_STATE_FILE etc.), so
// the same reset instant and attempt counter are shared across `run` and
// `tick`. The script exits 0 only if the final state is a single completed
// job — so it doubles as an end-to-end smoke test (see the vitest that drives
// it in packages/cli/test).

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const CLI = resolve(repoRoot, "packages/cli/dist/bin.js");

const argv = new Set(process.argv.slice(2));
const KEEP = argv.has("--keep");
const QUIET = argv.has("--quiet");

// How far out the fake rate limit resets. Small so the demo is quick; the
// vitest turns it down further via env. A couple of seconds keeps the countdown
// visible while staying snappy.
const RESET_SECONDS = Number(process.env.DEMO_RESET_SECONDS ?? "2");

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (fn, s) => (useColor ? fn(s) : s);

let stepNo = 0;
function step(title) {
  stepNo += 1;
  console.log(`\n${paint(c.bold, `▶ Step ${stepNo}: ${title}`)}`);
}
function note(msg) {
  if (!QUIET) console.log(paint(c.dim, `  ${msg}`));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Run the built CLI with the shared env + temp store; capture stdout so we can
// both echo it and assert on it. Never rejects on a non-zero exit — the relay's
// `run` step intentionally forwards the agent's non-zero code.
function runCli(args, env, { echo = true } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: env.DEMO_WORKDIR,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      if (echo && !QUIET) {
        for (const line of (stdout + stderr).trimEnd().split("\n")) {
          if (line.trim().length > 0) console.log(paint(c.dim, "  │ ") + line);
        }
      }
      resolvePromise({ code: code ?? 0, stdout, stderr });
    });
  });
}

function fail(message, extra) {
  console.error(`\n${paint(c.red, "✗ DEMO FAILED:")} ${message}`);
  if (extra) console.error(paint(c.dim, extra));
  process.exitCode = 1;
}

async function main() {
  if (!existsSync(CLI)) {
    fail(
      `built CLI not found at ${CLI}`,
      "Run `pnpm build` first so packages/cli/dist exists, then re-run this demo."
    );
    return;
  }

  const workdir = mkdtempSync(join(tmpdir(), "agentrelay-demo-"));
  const storePath = join(workdir, "jobs.json");
  const stateFile = join(workdir, "agent-state.json");
  const agentPath = join(workdir, "fake-agent.mjs");
  const resetAt = new Date(Date.now() + RESET_SECONDS * 1000).toISOString();

  // A deterministic stand-in for a real coding agent: fails once with a
  // rate-limit message, then succeeds. Attempt count is persisted so `run` and
  // the later `tick`-driven resume see a consistent story.
  writeFileSync(
    agentPath,
    [
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      "const stateFile = process.env.DEMO_STATE_FILE;",
      "let runs = 0;",
      "if (existsSync(stateFile)) runs = JSON.parse(readFileSync(stateFile, 'utf8')).runs ?? 0;",
      "runs += 1;",
      "writeFileSync(stateFile, JSON.stringify({ runs }));",
      "if (runs === 1) {",
      "  console.log('[fake-agent] Working on the task...');",
      "  console.log(`Claude usage limit reached. resets at ${process.env.DEMO_RESET_AT}`);",
      "  process.exit(1);",
      "}",
      "console.log('[fake-agent] Resumed after the reset — task finished successfully.');",
      "process.exit(0);",
      "",
    ].join("\n"),
    "utf8"
  );

  const env = {
    ...process.env,
    AGENTRELAY_STORE: storePath,
    DEMO_STATE_FILE: stateFile,
    DEMO_RESET_AT: resetAt,
    DEMO_WORKDIR: workdir,
    // Keep the demo hermetic: never fire real Slack/webhook notifications even
    // if the caller's shell has them configured.
    AGENTRELAY_SLACK_WEBHOOK: "",
    AGENTRELAY_WEBHOOK_URL: "",
  };
  const cli = (args, opts) => runCli(["--store", storePath, ...args], env, opts);

  console.log(paint(c.cyan, paint(c.bold, "AgentRelay — end-to-end demo")));
  note(`temp store: ${storePath}`);
  note(`fake reset window: ~${RESET_SECONDS}s (${resetAt})`);

  // ── Step 1: wrap the agent, hit the (fake) limit, get queued ──────────────
  step("Wrap an agent that hits its usage limit");
  note("$ agentrelay run --tool claude-code -- node fake-agent.mjs");
  const run = await cli(["run", "--tool", "claude-code", "--", process.execPath, agentPath]);
  if (!/Rate limit detected/i.test(run.stdout)) {
    fail("run did not detect the rate limit", run.stdout + run.stderr);
    cleanup(workdir);
    return;
  }

  // ── Step 2: the job is now waiting for its reset ──────────────────────────
  step("The job is queued, waiting for the reset");
  note("$ agentrelay status");
  const status1 = await cli(["status"]);
  if (!/waiting_for_reset/.test(status1.stdout)) {
    fail("expected a waiting_for_reset job after run", status1.stdout);
    cleanup(workdir);
    return;
  }
  note("$ agentrelay next");
  await cli(["next"]);

  // ── Step 3: wait out the (short) window, then tick to resume ──────────────
  step("Wait for the reset, then resume with a scheduler tick");
  const deadline = Date.now() + Math.max(RESET_SECONDS * 1000 + 8000, 10000);
  let due = false;
  while (Date.now() < deadline) {
    const probe = await cli(["next", "--exit-code"], { echo: false });
    if (probe.code === 0) {
      due = true;
      break;
    }
    await sleep(300);
  }
  if (!due) {
    fail("job never became due within the expected window");
    cleanup(workdir);
    return;
  }
  note("reset window elapsed — job is now due");
  note("$ agentrelay tick");
  const tick = await cli(["tick"]);
  if (!/->\s*completed/.test(tick.stdout)) {
    fail("tick did not complete the job", tick.stdout + tick.stderr);
    cleanup(workdir);
    return;
  }

  // ── Step 4: confirm the final state ───────────────────────────────────────
  step("Confirm exactly one completed job");
  note("$ agentrelay status");
  const status2 = await cli(["status"]);
  note("$ agentrelay stats");
  const stats = await cli(["stats", "--json"], { echo: false });
  let parsed;
  try {
    parsed = JSON.parse(stats.stdout);
  } catch {
    fail("could not parse `stats --json` output", stats.stdout);
    cleanup(workdir);
    return;
  }
  const byStatus = parsed.stats?.byStatus ?? {};
  if (parsed.stats?.total !== 1 || byStatus.completed !== 1) {
    fail(
      `expected 1 total / 1 completed, got total=${parsed.stats?.total} completed=${byStatus.completed}`,
      status2.stdout
    );
    cleanup(workdir);
    return;
  }

  console.log(`\n${paint(c.green, "✓ Demo passed:")} agent hit its limit, was queued, and auto-resumed to completion.`);
  cleanup(workdir);
}

function cleanup(workdir) {
  if (KEEP) {
    console.log(paint(c.dim, `\n(kept temp store at ${workdir})`));
    return;
  }
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    // best-effort; a leftover temp dir is harmless.
  }
}

main().catch((err) => {
  fail("unexpected error", String(err?.stack ?? err));
});
