import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { apiFetch, apiPost } from "../lib/api.js";
import { STATUS_COLORS, ACCENT, BRAND } from "../lib/chartColors.js";
import { showToast } from "./Toast.js";
import type { DriveDashboard as DriveDashboardData } from "@agentic-kanban/shared";

/**
 * Drive dashboard (#800) — an at-a-glance view of a running drive: N/N progress,
 * the dependency tier graph, current stalls, the last cascade (merge) event, and
 * cold-build-clean status. Data is the server-aggregated
 * `GET /api/projects/:id/drives/:driveId/dashboard` payload.
 */

interface DriveListItem {
  id: string;
  target: string;
  status: "active" | "completed" | "abandoned";
  startedAt: string;
  finishedAt: string | null;
}

interface DriveDashboardProps {
  projectId: string;
  onIssueClick?: (issueId: string) => void;
}

const POLL_MS = 15000;

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function statusColor(name: string): string {
  return STATUS_COLORS[name] ?? "#8a8175";
}

export function DriveDashboard({ projectId, onIssueClick }: DriveDashboardProps) {
  const [drives, setDrives] = useState<DriveListItem[]>([]);
  const [selectedDriveId, setSelectedDriveId] = useState<string | null>(null);
  const [data, setData] = useState<DriveDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showStartForm, setShowStartForm] = useState(false);

  // Load the drive list and default to the most recent active drive.
  const fetchDrives = useCallback(() => {
    if (!projectId) return;
    apiFetch<DriveListItem[]>(`/api/projects/${projectId}/drives`)
      .then((list) => {
        setDrives(list);
        setSelectedDriveId((prev) => {
          if (prev && list.some((d) => d.id === prev)) return prev;
          const active = list.find((d) => d.status === "active");
          return active?.id ?? list[0]?.id ?? null;
        });
        if (list.length === 0) setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load drives");
        setLoading(false);
      });
  }, [projectId]);

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  // A new drive was started — select it, close the form, and refresh the list so
  // it (and its dashboard) appear immediately.
  const handleStarted = useCallback(
    (driveId: string) => {
      setShowStartForm(false);
      setSelectedDriveId(driveId);
      fetchDrives();
    },
    [fetchDrives],
  );

  // Fetch (and poll) the selected drive's dashboard.
  const fetchDashboard = useCallback(() => {
    if (!projectId || !selectedDriveId) return;
    apiFetch<DriveDashboardData>(
      `/api/projects/${projectId}/drives/${selectedDriveId}/dashboard`,
    )
      .then((d) => {
        setData(d);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load drive dashboard");
        setLoading(false);
      });
  }, [projectId, selectedDriveId]);

  useEffect(() => {
    if (!selectedDriveId) return;
    setLoading(true);
    fetchDashboard();
    const isActive = drives.find((d) => d.id === selectedDriveId)?.status === "active";
    if (!isActive) return; // only poll a live drive
    const t = setInterval(fetchDashboard, POLL_MS);
    return () => clearInterval(t);
  }, [selectedDriveId, fetchDashboard, drives]);

  const maxTierWidth = useMemo(() => {
    if (!data) return 0;
    return Math.max(1, ...data.tiers.map((t) => t.issues.length));
  }, [data]);

  if (error && !data) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2 text-red-500">
        <span>{error}</span>
        <button
          onClick={fetchDrives}
          className="px-3 py-1 text-sm rounded bg-red-100 dark:bg-red-900/30 hover:bg-red-200 dark:hover:bg-red-900/50 text-red-700 dark:text-red-300"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!loading && drives.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-4 text-gray-400 dark:text-gray-500">
        {showStartForm ? (
          <div className="w-full max-w-lg">
            <StartDriveForm
              projectId={projectId}
              onStarted={handleStarted}
              onCancel={() => setShowStartForm(false)}
            />
          </div>
        ) : (
          <>
            <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span className="text-sm">No drives yet for this project.</span>
            <button
              onClick={() => setShowStartForm(true)}
              className="px-3 py-1.5 text-sm rounded-md font-medium text-white"
              style={{ backgroundColor: BRAND }}
            >
              Start a drive
            </button>
          </>
        )}
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500 dark:text-gray-400">
        <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
        Loading drive…
      </div>
    );
  }

  if (!data) return null;

  const { drive, progress, tiers, stalls, lastCascade, buildClean } = data;
  const statusBadge =
    drive.status === "active"
      ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
      : drive.status === "completed"
        ? "bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300"
        : "bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300";

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-auto">
      {/* Header: drive selector + target + status */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-brand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ color: BRAND }}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Drive Dashboard</h2>
        </div>
        {drives.length > 1 && (
          <select
            value={selectedDriveId ?? ""}
            onChange={(e) => setSelectedDriveId(e.target.value)}
            className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm max-w-xs"
          >
            {drives.map((d) => (
              <option key={d.id} value={d.id}>
                {d.status === "active" ? "▶ " : ""}
                {d.target.length > 50 ? d.target.slice(0, 50) + "…" : d.target}
              </option>
            ))}
          </select>
        )}
        <span className={`text-xs font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 ${statusBadge}`}>
          {drive.status}
        </span>
        <div className="ml-auto flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <span>Started {fmtTime(drive.startedAt)}</span>
          <button
            onClick={() => setShowStartForm((v) => !v)}
            className="px-2 py-1 rounded-md text-xs font-medium text-white"
            style={{ backgroundColor: BRAND }}
          >
            + Start drive
          </button>
          <button
            onClick={fetchDashboard}
            title="Refresh"
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {showStartForm && (
        <StartDriveForm
          projectId={projectId}
          onStarted={handleStarted}
          onCancel={() => setShowStartForm(false)}
        />
      )}

      <p className="text-sm text-gray-600 dark:text-gray-400 -mt-1">{drive.target}</p>

      {/* Progress + build-clean cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Progress */}
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Progress
            </span>
            <span className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {progress.done}/{progress.total}
              <span className="ml-1 text-sm font-normal text-gray-400">done</span>
            </span>
          </div>
          <div className="mt-3 h-2.5 w-full rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${progress.percentDone}%`, backgroundColor: ACCENT }}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
            <span><strong className="text-gray-900 dark:text-gray-100">{progress.inProgress}</strong> in progress</span>
            <span><strong className="text-gray-900 dark:text-gray-100">{progress.inReview}</strong> in review</span>
            <span><strong className="text-gray-900 dark:text-gray-100">{progress.todo}</strong> to do</span>
            <span className="ml-auto font-medium" style={{ color: ACCENT }}>{progress.percentDone}%</span>
          </div>
        </div>

        {/* Build-clean status */}
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Build-clean status
          </span>
          <div className="mt-3 flex flex-col gap-2 text-sm">
            <StatusRow
              ok={buildClean.coldCloneGateEnabled}
              label="Cold-clone build gate"
              okText="enabled"
              offText="not enabled"
            />
            <StatusRow
              ok={buildClean.verifyGateConfigured}
              label="Verify gate"
              okText="configured"
              offText="missing"
            />
            {buildClean.lastBuildEvent ? (
              <div className="mt-1 rounded bg-amber-50 dark:bg-amber-900/20 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-300">
                <span className="font-medium">Last build/verify event: </span>
                {buildClean.lastBuildEvent.issueNumber != null && (
                  <span className="font-mono">#{buildClean.lastBuildEvent.issueNumber} </span>
                )}
                {buildClean.lastBuildEvent.summary}
                <span className="ml-1 text-amber-600/70 dark:text-amber-400/60">
                  ({fmtTime(buildClean.lastBuildEvent.createdAt)})
                </span>
              </div>
            ) : (
              <span className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                No recent build/verify events.
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Last cascade event */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 flex items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 shrink-0">
          Last cascade
        </span>
        {lastCascade ? (
          <span className="text-sm text-gray-700 dark:text-gray-300 truncate">
            {lastCascade.issueNumber != null && (
              <span className="font-mono text-gray-500">#{lastCascade.issueNumber} </span>
            )}
            {lastCascade.summary}
            <span className="ml-2 text-xs text-gray-400">{fmtTime(lastCascade.createdAt)}</span>
          </span>
        ) : (
          <span className="text-sm text-gray-400 dark:text-gray-500">No merge events recorded yet.</span>
        )}
      </div>

      {/* Tier graph */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-3 py-2 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Dependency tier graph
          </span>
        </div>
        {tiers.length === 0 ? (
          <div className="px-3 py-6 text-sm text-center text-gray-400 dark:text-gray-500">
            No scoped issues — link a meta/epic issue with children to this drive.
          </div>
        ) : (
          <div className="p-3 flex flex-col gap-2 overflow-x-auto">
            {tiers.map(({ tier, issues }) => (
              <div key={tier} className="flex items-stretch gap-2">
                <div className="shrink-0 w-16 flex items-center justify-center text-xs font-semibold text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-gray-800/60 rounded">
                  Tier {tier}
                </div>
                <div
                  className="grid gap-2 flex-1"
                  style={{ gridTemplateColumns: `repeat(${maxTierWidth}, minmax(120px, 1fr))` }}
                >
                  {issues.map((issue) => (
                    <button
                      key={issue.id}
                      onClick={() => onIssueClick?.(issue.id)}
                      className="text-left rounded border border-gray-200 dark:border-gray-700 px-2 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors"
                      style={{ borderLeftWidth: 3, borderLeftColor: statusColor(issue.statusName) }}
                      title={issue.title}
                    >
                      <div className="text-[11px] font-mono text-gray-400">
                        {issue.issueNumber != null ? `#${issue.issueNumber}` : "—"}
                      </div>
                      <div className="text-xs text-gray-800 dark:text-gray-200 line-clamp-2">
                        {issue.title}
                      </div>
                      <div className="mt-0.5 text-[10px]" style={{ color: statusColor(issue.statusName) }}>
                        {issue.statusName}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Stalls / obstacle feed */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Current stalls
          </span>
          <span className="ml-auto text-xs font-medium text-gray-400 dark:text-gray-500 bg-gray-200 dark:bg-gray-700 rounded-full px-2 py-0.5">
            {stalls.length}
          </span>
        </div>
        {stalls.length === 0 ? (
          <div className="px-3 py-6 text-sm text-center text-gray-400 dark:text-gray-500">
            No stalls — every open issue is unblocked. 🎉
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
            {stalls.map((stall) => (
              <button
                key={stall.id}
                onClick={() => onIssueClick?.(stall.id)}
                className="w-full text-left flex flex-col gap-1 px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800/40"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-gray-400 shrink-0">
                    {stall.issueNumber != null ? `#${stall.issueNumber}` : "—"}
                  </span>
                  <span className="text-sm text-gray-800 dark:text-gray-200 truncate">{stall.title}</span>
                  <span
                    className="ml-auto text-[10px] shrink-0"
                    style={{ color: statusColor(stall.statusName) }}
                  >
                    {stall.statusName}
                  </span>
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 pl-6">
                  blocked by{" "}
                  {stall.blockedBy.map((b, i) => (
                    <span key={i}>
                      {i > 0 && ", "}
                      <span className="font-mono">
                        {b.issueNumber != null ? `#${b.issueNumber}` : b.title}
                      </span>
                    </span>
                  ))}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface PickerIssue {
  id: string;
  issueNumber: number | null;
  title: string;
}

/**
 * Inline "Start a drive" form (#845). Starting a drive previously required the API or the
 * drive-new-project skill; this brings it into the drive view. Target is required; the
 * meta/epic issue (optional) is what the dashboard's tier graph + scoped review-effectiveness
 * hang off, so we offer a picker of the project's issues. Completion contract is free text.
 */
function StartDriveForm({
  projectId,
  onStarted,
  onCancel,
}: {
  projectId: string;
  onStarted: (driveId: string) => void;
  onCancel: () => void;
}) {
  const [target, setTarget] = useState("");
  const [metaIssueId, setMetaIssueId] = useState("");
  const [contract, setContract] = useState("");
  const [issues, setIssues] = useState<PickerIssue[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<PickerIssue[]>(`/api/issues?projectId=${projectId}&slim=1`)
      .then(setIssues)
      .catch(() => setIssues([]));
  }, [projectId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target.trim()) {
      setErr("A target is required.");
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const drive = await apiPost<{ id: string }>(`/api/projects/${projectId}/drives`, {
          target: target.trim(),
          metaIssueId: metaIssueId || null,
          completionContract: contract.trim() || null,
        });
      showToast("Drive started", "success");
      onStarted(drive.id);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Failed to start drive");
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-4 flex flex-col gap-3"
    >
      <div className="flex items-center gap-2">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ color: BRAND }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">Start a drive</span>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
          Target <span className="text-red-500">*</span>
        </span>
        <input
          type="text"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="e.g. Drive the auth epic to master"
          autoFocus
          className="px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Meta / epic issue (optional)</span>
        <select
          value={metaIssueId}
          onChange={(e) => setMetaIssueId(e.target.value)}
          className="px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100"
        >
          <option value="">— none —</option>
          {issues.map((i) => (
            <option key={i.id} value={i.id}>
              {i.issueNumber != null ? `#${i.issueNumber} ` : ""}
              {i.title}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Completion contract (optional)</span>
        <textarea
          value={contract}
          onChange={(e) => setContract(e.target.value)}
          rows={2}
          placeholder="e.g. All children Done AND master contains the work"
          className="px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 resize-y"
        />
      </label>

      {err && <span className="text-xs text-red-500">{err}</span>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting || !target.trim()}
          className="px-3 py-1.5 text-sm rounded-md font-medium text-white disabled:opacity-50"
          style={{ backgroundColor: BRAND }}
        >
          {submitting ? "Starting…" : "Start drive"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="px-3 py-1.5 text-sm rounded-md text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function StatusRow({
  ok,
  label,
  okText,
  offText,
}: {
  ok: boolean;
  label: string;
  okText: string;
  offText: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`inline-flex w-4 h-4 items-center justify-center rounded-full text-white text-[10px] ${
          ok ? "bg-emerald-500" : "bg-gray-300 dark:bg-gray-600"
        }`}
      >
        {ok ? "✓" : "—"}
      </span>
      <span className="text-gray-700 dark:text-gray-300">{label}</span>
      <span className={`ml-auto text-xs ${ok ? "text-emerald-600 dark:text-emerald-400" : "text-gray-400"}`}>
        {ok ? okText : offText}
      </span>
    </div>
  );
}
