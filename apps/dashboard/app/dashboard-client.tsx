"use client";

import type { HeartbeatStatus, JobStatus, ProjectBreakdown, RelayJob, ToolBreakdown } from "@agentrelay/core";
import { type ReactNode, useEffect, useState } from "react";
import { describeFilter, filterJobsByStatus, isFilterActive, toggleStatus } from "../lib/filter";
import type { JobsSnapshot } from "../lib/jobs";

const POLL_INTERVAL_MS = 3000;

/** Left-to-right order for describing an active multi-status filter. */
const STATUS_ORDER: JobStatus[] = ["queued", "waiting_for_reset", "resuming", "completed", "failed", "cancelled"];

const STATUS_META: Record<JobStatus, { label: string; colorVar: string }> = {
  queued: { label: "Queued", colorVar: "var(--ink-muted)" },
  waiting_for_reset: { label: "Waiting for reset", colorVar: "var(--status-warning)" },
  resuming: { label: "Resuming", colorVar: "var(--accent-running)" },
  completed: { label: "Completed", colorVar: "var(--status-good)" },
  failed: { label: "Failed", colorVar: "var(--status-critical)" },
  cancelled: { label: "Cancelled", colorVar: "var(--ink-muted)" },
};

const STATUS_LABELS = Object.fromEntries(
  (Object.keys(STATUS_META) as JobStatus[]).map((status) => [status, STATUS_META[status].label])
) as Record<JobStatus, string>;

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

function StatusBadge({ status }: { status: JobStatus }) {
  const meta = STATUS_META[status] ?? { label: status, colorVar: "var(--ink-muted)" };
  return (
    <span className="badge">
      <span className="dot" style={{ background: meta.colorVar }} aria-hidden />
      {meta.label}
    </span>
  );
}

/**
 * A summary tile that doubles as a status filter toggle. Clicking it toggles
 * whether the job list is filtered to `status`; `pressed` drives the active
 * styling and `aria-pressed` for assistive tech. `sub` renders optional
 * secondary text (e.g. the next-reset countdown).
 */
function FilterTile({
  status,
  value,
  pressed,
  onToggle,
  sub,
}: {
  status: JobStatus;
  value: number | string;
  pressed: boolean;
  onToggle: (status: JobStatus) => void;
  sub?: ReactNode;
}) {
  const meta = STATUS_META[status];
  return (
    <button
      type="button"
      className={`tile tile-toggle${pressed ? " is-active" : ""}`}
      aria-pressed={pressed}
      onClick={() => onToggle(status)}
      title={pressed ? `Showing only ${meta.label} — click to clear` : `Filter to ${meta.label}`}
    >
      <div className="label">
        <span className="dot" style={{ background: meta.colorVar }} aria-hidden />
        {meta.label}
      </div>
      <div className="value numeric">{value}</div>
      {sub !== undefined && <div className="sub">{sub}</div>}
    </button>
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
  const [statusFilter, setStatusFilter] = useState<Set<JobStatus>>(() => new Set());

  const toggleStatusFilter = (status: JobStatus) => setStatusFilter((prev) => toggleStatus(prev, status));
  const clearStatusFilter = () => setStatusFilter(new Set());

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
  const filtering = isFilterActive(statusFilter);
  const visibleJobs = filterJobsByStatus(jobs, statusFilter);
  const filterLabel = describeFilter(statusFilter, STATUS_LABELS, STATUS_ORDER);

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

      <section className="tile-row" aria-label="Queue summary — click a status to filter the job list">
        <FilterTile
          status="waiting_for_reset"
          value={summary?.byStatus.waiting_for_reset ?? "–"}
          pressed={statusFilter.has("waiting_for_reset")}
          onToggle={toggleStatusFilter}
          sub={
            <>
              next reset in <span className="numeric">{formatCountdown(summary?.nextResetAt ?? null, now)}</span>
            </>
          }
        />
        <FilterTile
          status="resuming"
          value={summary?.byStatus.resuming ?? "–"}
          pressed={statusFilter.has("resuming")}
          onToggle={toggleStatusFilter}
        />
        <FilterTile
          status="completed"
          value={summary?.byStatus.completed ?? "–"}
          pressed={statusFilter.has("completed")}
          onToggle={toggleStatusFilter}
        />
        <FilterTile
          status="failed"
          value={summary?.byStatus.failed ?? "–"}
          pressed={statusFilter.has("failed")}
          onToggle={toggleStatusFilter}
        />
        <button
          type="button"
          className={`tile tile-toggle${filtering ? "" : " is-active"}`}
          aria-pressed={!filtering}
          onClick={clearStatusFilter}
          title={filtering ? "Clear the status filter — show all jobs" : "Showing all jobs"}
        >
          <div className="label">All jobs</div>
          <div className="value numeric">{summary?.total ?? "–"}</div>
          {filtering && <div className="sub">click to clear filter</div>}
        </button>
      </section>

      {hasRollup && (
        <section className="rollup-grid" aria-label="Rollups by project and tool">
          <RollupCard title="By project" keyHeader="Project" rows={projectRows} now={now} />
          <RollupCard title="By tool" keyHeader="Tool" rows={toolRows} now={now} />
        </section>
      )}

      <section className="jobs-card" aria-label="Job list">
        {filtering && jobs.length > 0 && (
          <div className="filter-note">
            <span>
              Showing <span className="numeric">{visibleJobs.length}</span> of{" "}
              <span className="numeric">{jobs.length}</span> · filtered to <strong>{filterLabel}</strong>
            </span>
            <button type="button" className="filter-clear" onClick={clearStatusFilter}>
              Show all
            </button>
          </div>
        )}
        {jobs.length === 0 ? (
          <div className="empty">
            <p>No jobs yet.</p>
            <p>
              Wrap an agent call with <code>agentrelay run -- claude -p &quot;...&quot;</code> — when it hits a rate
              limit, the job shows up here and resumes automatically.
            </p>
          </div>
        ) : visibleJobs.length === 0 ? (
          <div className="empty">
            <p>No {filterLabel} jobs.</p>
            <p>
              Nothing in the queue matches this filter.{" "}
              <button type="button" className="filter-clear inline" onClick={clearStatusFilter}>
                Show all jobs
              </button>
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
              {visibleJobs.map((job) => (
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
