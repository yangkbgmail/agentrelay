"use client";

import type { HeartbeatStatus, JobStatus, RelayJob } from "@agentrelay/core";
import { useEffect, useMemo, useState } from "react";
import { type DashboardFilter, distinctProjects, distinctTools, filterJobs, isFilterActive } from "../lib/filter";
import type { JobsSnapshot } from "../lib/jobs";

const POLL_INTERVAL_MS = 3000;

/** Status order shown as toggleable filter chips (queue lifecycle order). */
const FILTER_STATUSES: JobStatus[] = ["queued", "waiting_for_reset", "resuming", "completed", "failed", "cancelled"];

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

function FilterBar({
  filter,
  onChange,
  tools,
  projects,
}: {
  filter: DashboardFilter;
  onChange: (next: DashboardFilter) => void;
  tools: string[];
  projects: string[];
}) {
  const selectedStatuses = new Set(filter.statuses ?? []);

  function toggleStatus(status: JobStatus) {
    const next = new Set(selectedStatuses);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    onChange({ ...filter, statuses: Array.from(next) });
  }

  const active = isFilterActive(filter);

  return (
    <section className="filter-bar" aria-label="Filter jobs">
      <div className="filter-row">
        <input
          type="search"
          className="filter-search"
          placeholder="Search project, id, or command…"
          value={filter.search ?? ""}
          onChange={(e) => onChange({ ...filter, search: e.target.value })}
          aria-label="Search jobs"
        />
        <select
          className="filter-select"
          value={(filter.tools ?? [])[0] ?? ""}
          onChange={(e) => onChange({ ...filter, tools: e.target.value ? [e.target.value] : [] })}
          aria-label="Filter by tool"
        >
          <option value="">All tools</option>
          {tools.map((tool) => (
            <option key={tool} value={tool}>
              {tool}
            </option>
          ))}
        </select>
        <select
          className="filter-select"
          value={(filter.projects ?? [])[0] ?? ""}
          onChange={(e) => onChange({ ...filter, projects: e.target.value ? [e.target.value] : [] })}
          aria-label="Filter by project"
        >
          <option value="">All projects</option>
          {projects.map((project) => (
            <option key={project} value={project}>
              {project}
            </option>
          ))}
        </select>
        {active && (
          <button type="button" className="filter-clear" onClick={() => onChange({})}>
            Clear
          </button>
        )}
      </div>
      <fieldset className="filter-chips" aria-label="Filter by status">
        {FILTER_STATUSES.map((status) => {
          const meta = STATUS_META[status];
          const on = selectedStatuses.has(status);
          return (
            <button
              key={status}
              type="button"
              className={`filter-chip${on ? " on" : ""}`}
              aria-pressed={on}
              onClick={() => toggleStatus(status)}
            >
              <span className="dot" style={{ background: meta.colorVar }} aria-hidden />
              {meta.label}
            </button>
          );
        })}
      </fieldset>
    </section>
  );
}

export default function DashboardClient() {
  const [snapshot, setSnapshot] = useState<JobsSnapshot | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState<DashboardFilter>({});

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
  const tools = useMemo(() => distinctTools(jobs), [jobs]);
  const projects = useMemo(() => distinctProjects(jobs), [jobs]);
  const filteredJobs = useMemo(() => filterJobs(jobs, filter), [jobs, filter]);
  const filtering = isFilterActive(filter);

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

      {jobs.length > 0 && <FilterBar filter={filter} onChange={setFilter} tools={tools} projects={projects} />}

      <section className="jobs-card" aria-label="Job list">
        {jobs.length === 0 ? (
          <div className="empty">
            <p>No jobs yet.</p>
            <p>
              Wrap an agent call with <code>agentrelay run -- claude -p &quot;...&quot;</code> — when it hits a rate
              limit, the job shows up here and resumes automatically.
            </p>
          </div>
        ) : filteredJobs.length === 0 ? (
          <div className="empty">
            <p>No jobs match the current filter.</p>
            <p>
              <button type="button" className="filter-clear" onClick={() => setFilter({})}>
                Clear filter
              </button>
            </p>
          </div>
        ) : (
          <>
            {filtering && (
              <div className="filter-count numeric">
                Showing {filteredJobs.length} of {jobs.length} jobs
              </div>
            )}
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
                {filteredJobs.map((job) => (
                  <JobRow key={job.id} job={job} now={now} />
                ))}
              </tbody>
            </table>
          </>
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
