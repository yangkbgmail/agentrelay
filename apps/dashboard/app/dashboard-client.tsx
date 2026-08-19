"use client";

import type {
  HeartbeatStatus,
  JobStatus,
  ProjectBreakdown,
  RelayJob,
  ToolBreakdown,
  UpcomingTimeline,
} from "@agentrelay/core";
import { useEffect, useState } from "react";
import type { JobsSnapshot } from "../lib/jobs";

const POLL_INTERVAL_MS = 3000;

const STATUS_META: Record<JobStatus, { label: string; colorVar: string }> = {
  queued: { label: "Queued", colorVar: "var(--ink-muted)" },
  waiting_for_reset: { label: "Waiting for reset", colorVar: "var(--status-warning)" },
  resuming: { label: "Resuming", colorVar: "var(--accent-running)" },
  completed: { label: "Completed", colorVar: "var(--status-good)" },
  failed: { label: "Failed", colorVar: "var(--status-critical)" },
  cancelled: { label: "Cancelled", colorVar: "var(--ink-muted)" },
};

function formatCountdown(resetAt: string | null, now: number): string {
  if (!resetAt) return "—";
  const ms = new Date(resetAt).getTime() - now;
  if (Number.isNaN(ms)) return "—";
  if (ms <= 0) return "due now";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function formatClock(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function formatAge(ms: number | undefined): string {
  if (ms === undefined) return "unknown";
  if (ms <= 1000) return "just now";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ago`;
  if (hours > 0) return `${hours}h ${minutes}m ago`;
  if (minutes > 0) return `${minutes}m ${seconds}s ago`;
  return `${seconds}s ago`;
}

const HEARTBEAT_META: Record<HeartbeatStatus["state"], { label: string; colorVar: string }> = {
  alive: { label: "Resume loop running", colorVar: "var(--status-good)" },
  stale: { label: "Resume loop stopped", colorVar: "var(--status-warning)" },
  absent: { label: "No resume loop", colorVar: "var(--ink-muted)" },
};

function heartbeatDetail(hb: HeartbeatStatus): string {
  const who = hb.mode === "tick" ? "tick" : "daemon";
  if (hb.state === "alive") {
    const pid = hb.pid !== undefined ? ` (pid ${hb.pid})` : "";
    return `${who}${pid} · last tick ${formatAge(hb.ageMs)}`;
  }
  if (hb.state === "stale") {
    const pid = hb.pid !== undefined ? ` (pid ${hb.pid})` : "";
    return `last tick ${formatAge(hb.ageMs)}${pid} — it may have crashed or been stopped`;
  }
  return "no daemon or tick has run yet";
}

function ResumeLoopCard({ heartbeat }: { heartbeat: HeartbeatStatus | undefined }) {
  if (!heartbeat) return null;
  const meta = HEARTBEAT_META[heartbeat.state];
  const waiting = heartbeat.waitingJobs;

  return (
    <section className={`resume-loop${heartbeat.concerning ? " concerning" : ""}`} aria-label="Resume loop status">
      <div className="resume-loop-head">
        <span className="dot" style={{ background: meta.colorVar }} aria-hidden />
        <span className="resume-loop-label">{meta.label}</span>
        {waiting > 0 && <span className="resume-loop-waiting numeric">{waiting} waiting to resume</span>}
      </div>
      <div className="resume-loop-detail">{heartbeatDetail(heartbeat)}</div>
      {heartbeat.concerning && (
        <div className="resume-loop-hint">
          {waiting} job(s) are waiting to resume but nothing is running to pick them up. Start{" "}
          <code>agentrelay daemon</code> (or schedule <code>agentrelay tick</code> via cron).
        </div>
      )}
    </section>
  );
}

/**
 * A single rollup row, flattened from either a {@link ProjectBreakdown} (keyed
 * by project) or a {@link ToolBreakdown} (keyed by tool). Both core summaries
 * share the same count/timing shape, so one renderer covers both axes.
 */
interface RollupRow {
  label: string;
  total: number;
  active: number;
  waiting: number;
  terminal: number;
  nextResetAt: string | null;
}

function projectRow(p: ProjectBreakdown): RollupRow {
  return {
    label: p.project,
    total: p.total,
    active: p.active,
    waiting: p.waiting,
    terminal: p.terminal,
    nextResetAt: p.nextResetAt,
  };
}

function toolRow(t: ToolBreakdown): RollupRow {
  return {
    label: t.tool,
    total: t.total,
    active: t.active,
    waiting: t.waiting,
    terminal: t.terminal,
    nextResetAt: t.nextResetAt,
  };
}

function RollupCard({
  title,
  keyHeader,
  rows,
  now,
}: {
  title: string;
  keyHeader: string;
  rows: RollupRow[];
  now: number;
}) {
  return (
    <section className="rollup-card" aria-label={title}>
      <h2 className="rollup-title">{title}</h2>
      {rows.length === 0 ? (
        <p className="rollup-empty">No jobs yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{keyHeader}</th>
              <th className="numeric">Active</th>
              <th className="numeric">Waiting</th>
              <th className="numeric">Done</th>
              <th className="numeric">Total</th>
              <th className="numeric">Next reset</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td className="numeric">{row.active}</td>
                <td className="numeric">{row.waiting}</td>
                <td className="numeric">{row.terminal}</td>
                <td className="numeric">{row.total}</td>
                <td className="numeric">{row.waiting > 0 ? formatCountdown(row.nextResetAt, now) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * The forward-looking resume runway: `waiting_for_reset` jobs ordered by when
 * they come due (mirror of `agentrelay upcoming`). The order and membership are
 * computed server-side by core's `buildUpcomingTimeline` (so they never drift
 * from the CLI/scheduler), but each row's countdown and its "due now" state are
 * recomputed here against the live `now` clock so the runway ticks every second
 * — reset times don't change between polls, so the server ordering stays valid.
 */
function UpcomingCard({ upcoming, now }: { upcoming: UpcomingTimeline | undefined; now: number }) {
  if (!upcoming || upcoming.totalWaiting === 0) return null;

  return (
    <section className="upcoming-card" aria-label="Upcoming resumes">
      <div className="upcoming-head">
        <h2 className="rollup-title">Upcoming resumes</h2>
        <span className="upcoming-count numeric">
          {upcoming.totalWaiting} waiting
          {upcoming.dueNow > 0 && <span className="upcoming-due"> · {upcoming.dueNow} due now</span>}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th className="numeric">#</th>
            <th>Project / job</th>
            <th>Command</th>
            <th className="numeric">Resets in</th>
            <th className="numeric">Reset at</th>
          </tr>
        </thead>
        <tbody>
          {upcoming.entries.map((entry) => {
            const resetMs = entry.job.resetAt ? new Date(entry.job.resetAt).getTime() : Number.NaN;
            const due = !Number.isNaN(resetMs) && resetMs <= now;
            return (
              <tr key={entry.job.id} className={due ? "upcoming-due-row" : undefined}>
                <td className="numeric">{entry.position}</td>
                <td>
                  <div>{entry.job.project}</div>
                  <div className="job-id">{entry.job.id.slice(0, 8)}</div>
                </td>
                <td className="cmd">{entry.job.command.join(" ")}</td>
                <td className="numeric">{formatCountdown(entry.job.resetAt, now)}</td>
                <td className="numeric">{formatClock(entry.job.resetAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {upcoming.hidden > 0 && (
        <div className="upcoming-more">
          +{upcoming.hidden} more waiting job{upcoming.hidden === 1 ? "" : "s"} not shown
        </div>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: JobStatus }) {
  const meta = STATUS_META[status] ?? { label: status, colorVar: "var(--ink-muted)" };
  return (
    <span className="badge">
      <span className="dot" style={{ background: meta.colorVar }} aria-hidden />
      {meta.label}
    </span>
  );
}

function JobRow({ job, now }: { job: RelayJob; now: number }) {
  const tail = job.lastError ?? job.lastOutputTail;
  return (
    <tr>
      <td>
        <div>{job.project}</div>
        <div className="job-id">{job.id.slice(0, 8)}</div>
      </td>
      <td>
        <StatusBadge status={job.status} />
      </td>
      <td className="cmd">{job.command.join(" ")}</td>
      <td className="numeric">{formatCountdown(job.resetAt, now)}</td>
      <td className="numeric">{job.attempts}</td>
      <td className="numeric">{formatClock(job.updatedAt)}</td>
      <td>
        {tail ? (
          <details className="tail">
            <summary>{job.lastError ? "last error" : "output tail"}</summary>
            <pre>{tail}</pre>
          </details>
        ) : (
          <span className="job-id">—</span>
        )}
      </td>
    </tr>
  );
}

export default function DashboardClient() {
  const [snapshot, setSnapshot] = useState<JobsSnapshot | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/jobs", { cache: "no-store" });
        if (!res.ok) throw new Error(`API responded with HTTP ${res.status}`);
        const data: JobsSnapshot = await res.json();
        if (!cancelled) {
          setSnapshot(data);
          setFetchError(null);
        }
      } catch (err) {
        if (!cancelled) setFetchError(String(err));
      }
    }

    void poll();
    const pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    const clockTimer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      clearInterval(clockTimer);
    };
  }, []);

  const jobs = snapshot?.jobs ?? [];
  const summary = snapshot?.summary;
  const projectRows = (snapshot?.projects.projects ?? []).map(projectRow);
  const toolRows = (snapshot?.tools.tools ?? []).map(toolRow);
  const hasRollup = projectRows.length > 0 || toolRows.length > 0;

  return (
    <>
      <header className="page-header">
        <h1>AgentRelay</h1>
        <p>Rate-limited agent jobs, auto-resumed when the limit resets.</p>
      </header>

      {fetchError && (
        <div className="error-banner" role="alert">
          Could not read the job store: {fetchError}
        </div>
      )}

      <ResumeLoopCard heartbeat={snapshot?.heartbeat} />

      <section className="tile-row" aria-label="Queue summary">
        <div className="tile">
          <div className="label">
            <span className="dot" style={{ background: "var(--status-warning)" }} aria-hidden />
            Waiting for reset
          </div>
          <div className="value numeric">{summary?.byStatus.waiting_for_reset ?? "–"}</div>
          <div className="sub">
            next reset in <span className="numeric">{formatCountdown(summary?.nextResetAt ?? null, now)}</span>
          </div>
        </div>
        <div className="tile">
          <div className="label">
            <span className="dot" style={{ background: "var(--accent-running)" }} aria-hidden />
            Resuming
          </div>
          <div className="value numeric">{summary?.byStatus.resuming ?? "–"}</div>
        </div>
        <div className="tile">
          <div className="label">
            <span className="dot" style={{ background: "var(--status-good)" }} aria-hidden />
            Completed
          </div>
          <div className="value numeric">{summary?.byStatus.completed ?? "–"}</div>
        </div>
        <div className="tile">
          <div className="label">
            <span className="dot" style={{ background: "var(--status-critical)" }} aria-hidden />
            Failed
          </div>
          <div className="value numeric">{summary?.byStatus.failed ?? "–"}</div>
        </div>
        <div className="tile">
          <div className="label">Total jobs</div>
          <div className="value numeric">{summary?.total ?? "–"}</div>
        </div>
      </section>

      <UpcomingCard upcoming={snapshot?.upcoming} now={now} />

      {hasRollup && (
        <section className="rollup-grid" aria-label="Rollups by project and tool">
          <RollupCard title="By project" keyHeader="Project" rows={projectRows} now={now} />
          <RollupCard title="By tool" keyHeader="Tool" rows={toolRows} now={now} />
        </section>
      )}

      <section className="jobs-card" aria-label="Job list">
        {jobs.length === 0 ? (
          <div className="empty">
            <p>No jobs yet.</p>
            <p>
              Wrap an agent call with <code>agentrelay run -- claude -p &quot;...&quot;</code> — when it hits a rate
              limit, the job shows up here and resumes automatically.
            </p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Project / job</th>
                <th>Status</th>
                <th>Command</th>
                <th>Resets in</th>
                <th>Attempts</th>
                <th>Updated</th>
                <th>Last output</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <JobRow key={job.id} job={job} now={now} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="meta-line">
        <span>
          store: <span className="store-path">{snapshot?.storePath ?? "…"}</span>
        </span>
        <span>refreshed {snapshot ? formatClock(snapshot.generatedAt) : "…"} · polls every 3s</span>
      </div>
    </>
  );
}
