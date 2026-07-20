"use client";

import type { JobStatus, RelayJob } from "@agentrelay/core";
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

function ResumeLoopBanner({ health }: { health: JobsSnapshot["resumeLoop"] }) {
  const colorVar =
    health.level === "warning"
      ? "var(--status-warning)"
      : health.state === "alive"
        ? "var(--status-good)"
        : "var(--ink-muted)";
  return (
    <div className={`resume-banner ${health.level}`} role={health.level === "warning" ? "alert" : undefined}>
      <span className="dot" style={{ background: colorVar }} aria-hidden />
      <span>{health.message}</span>
    </div>
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

      {snapshot?.resumeLoop && <ResumeLoopBanner health={snapshot.resumeLoop} />}

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
