import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";

type DigestRange = "24h" | "3d" | "7d";

interface DigestIssueRef {
  issueId: string;
  issueNumber: number | null;
  title: string;
  statusName: string;
  priority: string;
  issueType: string;
  at: string;
}

interface SessionDigestEntry {
  sessionId: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  startedAt: string;
  endedAt: string | null;
  success: boolean;
  durationMs: number;
  costUsd: number;
  triggerType: string | null;
}

interface DigestData {
  range: DigestRange;
  since: string;
  now: string;
  created: DigestIssueRef[];
  completed: DigestIssueRef[];
  moved: DigestIssueRef[];
  merged: Array<{
    workspaceId: string;
    issueId: string;
    issueNumber: number | null;
    issueTitle: string;
    branch: string;
    closedAt: string;
  }>;
  sessions: SessionDigestEntry[];
  blocked: DigestIssueRef[];
  headline: {
    createdCount: number;
    completedCount: number;
    mergedCount: number;
    sessionCount: number;
    sessionSuccessCount: number;
    totalCostUsd: number;
    blockedCount: number;
    activeAgents: number;
  };
}

interface DigestViewProps {
  projectId: string;
  onIssueClick: (issueId: string) => void;
}

const RANGE_OPTIONS: Array<{ value: DigestRange; label: string }> = [
  { value: "24h", label: "Last 24h" },
  { value: "3d", label: "Last 3 days" },
  { value: "7d", label: "Last 7 days" },
];

const PRIORITY_COLOR: Record<string, string> = {
  critical: "#ef4444",
  urgent: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#94a3b8",
};

function relativeTime(iso: string, now: Date): string {
  const diffMs = now.getTime() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 flex flex-col gap-0.5">
      <span className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide font-medium">{label}</span>
      <span className="text-2xl font-bold" style={color ? { color } : undefined}>{value}</span>
      {sub && <span className="text-xs text-gray-400 dark:text-gray-500">{sub}</span>}
    </div>
  );
}

function IssueRow({ issue, now, onIssueClick, accent }: { issue: DigestIssueRef; now: Date; onIssueClick: (id: string) => void; accent: string }) {
  return (
    <button onClick={() => onIssueClick(issue.issueId)} className="flex items-start gap-2 text-left group w-full py-1">
      <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: accent }} />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-gray-700 dark:text-gray-300 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
          {issue.issueNumber != null && <span className="text-gray-400 dark:text-gray-500">#{issue.issueNumber} </span>}
          {issue.title}
        </p>
        <p className="text-[10px] text-gray-400 dark:text-gray-500 flex items-center gap-1.5">
          <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: PRIORITY_COLOR[issue.priority] ?? "#94a3b8" }} />
          {issue.statusName} · {relativeTime(issue.at, now)}
        </p>
      </div>
    </button>
  );
}

function Section({ title, count, accent, children }: { title: string; count: number; accent: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2 flex items-center gap-2">
        <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: accent }} />
        {title}
        <span className="text-xs font-normal text-gray-400 dark:text-gray-500">({count})</span>
      </h3>
      {children}
    </div>
  );
}

export function DigestView({ projectId, onIssueClick }: DigestViewProps) {
  const [range, setRange] = useState<DigestRange>("24h");
  const [data, setData] = useState<DigestData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<DigestData>(`/api/digest?projectId=${encodeURIComponent(projectId)}&range=${range}`)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load digest");
          setData(null);
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, range]);

  const now = data ? new Date(data.now) : new Date();
  const h = data?.headline;
  const nothingHappened = data && h &&
    h.createdCount === 0 && h.completedCount === 0 && h.mergedCount === 0 &&
    h.sessionCount === 0 && h.blockedCount === 0;

  return (
    <div className="flex-1 min-h-0 overflow-auto px-4 pb-6">
      <div className="max-w-5xl mx-auto space-y-5 pt-3">

        {/* Header + range toggle */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100">Standup Digest</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">What changed on the board while you were away.</p>
          </div>
          <div className="flex gap-1.5">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => setRange(option.value)}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors ${range === option.value ? "bg-brand-600 text-white" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {loading && <p className="text-sm text-gray-400 dark:text-gray-500">Loading digest…</p>}
        {error && <p className="text-sm text-red-500">{error}</p>}

        {data && h && (
          <>
            {/* Headline cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Created" value={h.createdCount} sub="new issues" color={h.createdCount > 0 ? "#3b82f6" : undefined} />
              <StatCard label="Completed" value={h.completedCount} sub="done + cancelled" color={h.completedCount > 0 ? "#22c55e" : undefined} />
              <StatCard label="Merged" value={h.mergedCount} sub="workspaces" color={h.mergedCount > 0 ? "#06b6d4" : undefined} />
              <StatCard
                label="Agent runs"
                value={h.sessionCount}
                sub={h.sessionCount > 0 ? `${h.sessionSuccessCount} ok · $${h.totalCostUsd.toFixed(2)}` : "no sessions"}
                color={h.sessionCount > 0 ? "#8b5cf6" : undefined}
              />
            </div>

            {(h.activeAgents > 0 || h.blockedCount > 0) && (
              <div className="flex flex-wrap gap-2">
                {h.activeAgents > 0 && (
                  <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300">
                    <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" />
                    {h.activeAgents} agent{h.activeAgents !== 1 ? "s" : ""} running now
                  </span>
                )}
                {h.blockedCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300">
                    {h.blockedCount} blocked issue{h.blockedCount !== 1 ? "s" : ""} need attention
                  </span>
                )}
              </div>
            )}

            {nothingHappened && (
              <div className="flex flex-col items-center justify-center py-16 gap-3 text-gray-400 dark:text-gray-500">
                <svg className="w-12 h-12 opacity-25" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <p className="text-sm">All quiet — nothing changed in this window.</p>
              </div>
            )}

            {!nothingHappened && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Section title="Completed" count={data.completed.length} accent="#22c55e">
                  {data.completed.length === 0
                    ? <p className="text-xs text-gray-400 dark:text-gray-500">Nothing completed yet.</p>
                    : data.completed.map((i) => <IssueRow key={i.issueId} issue={i} now={now} onIssueClick={onIssueClick} accent="#22c55e" />)}
                </Section>

                <Section title="Merged" count={data.merged.length} accent="#06b6d4">
                  {data.merged.length === 0
                    ? <p className="text-xs text-gray-400 dark:text-gray-500">No merges in this window.</p>
                    : data.merged.map((m) => (
                      <button key={m.workspaceId} onClick={() => onIssueClick(m.issueId)} className="flex items-start gap-2 text-left group w-full py-1">
                        <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 bg-cyan-400" />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-gray-700 dark:text-gray-300 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                            {m.issueNumber != null && <span className="text-gray-400 dark:text-gray-500">#{m.issueNumber} </span>}
                            {m.issueTitle}
                          </p>
                          <p className="text-[10px] text-gray-400 dark:text-gray-500 truncate font-mono">{m.branch} · {relativeTime(m.closedAt, now)}</p>
                        </div>
                      </button>
                    ))}
                </Section>

                <Section title="New issues" count={data.created.length} accent="#3b82f6">
                  {data.created.length === 0
                    ? <p className="text-xs text-gray-400 dark:text-gray-500">No new issues.</p>
                    : data.created.map((i) => <IssueRow key={i.issueId} issue={i} now={now} onIssueClick={onIssueClick} accent="#3b82f6" />)}
                </Section>

                <Section title="Moved" count={data.moved.length} accent="#f59e0b">
                  {data.moved.length === 0
                    ? <p className="text-xs text-gray-400 dark:text-gray-500">No status changes.</p>
                    : data.moved.map((i) => <IssueRow key={i.issueId} issue={i} now={now} onIssueClick={onIssueClick} accent="#f59e0b" />)}
                </Section>

                {data.blocked.length > 0 && (
                  <Section title="Blocked — needs attention" count={data.blocked.length} accent="#ef4444">
                    {data.blocked.map((i) => <IssueRow key={i.issueId} issue={i} now={now} onIssueClick={onIssueClick} accent="#ef4444" />)}
                  </Section>
                )}

                <Section title="Agent runs" count={data.sessions.length} accent="#8b5cf6">
                  {data.sessions.length === 0
                    ? <p className="text-xs text-gray-400 dark:text-gray-500">No agent sessions ran.</p>
                    : data.sessions.slice(0, 12).map((s) => (
                      <button key={s.sessionId} onClick={() => onIssueClick(s.issueId)} className="flex items-start gap-2 text-left group w-full py-1">
                        <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${s.endedAt == null ? "bg-violet-500 animate-pulse" : s.success ? "bg-green-400" : "bg-red-400"}`} />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-gray-700 dark:text-gray-300 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                            {s.issueNumber != null && <span className="text-gray-400 dark:text-gray-500">#{s.issueNumber} </span>}
                            {s.issueTitle}
                          </p>
                          <p className="text-[10px] text-gray-400 dark:text-gray-500">
                            {s.endedAt == null ? "running" : s.success ? "succeeded" : "failed"} · {formatDuration(s.durationMs)}
                            {s.costUsd > 0 && ` · $${s.costUsd.toFixed(2)}`} · {relativeTime(s.startedAt, now)}
                          </p>
                        </div>
                      </button>
                    ))}
                </Section>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
