import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { BRAND, ACCENT } from "../lib/chartColors";

interface FocusIssue {
  issueId: string;
  issueNumber: number | null;
  title: string;
  statusName: string;
  priority: string;
  issueType: string;
  estimate: string | null;
  blockedBy: Array<{ issueId: string; issueNumber: number | null; title: string }>;
  unblocks: number;
  focusScore: number;
  reasons: string[];
}

interface FocusData {
  now: string;
  ready: FocusIssue[];
  blocked: FocusIssue[];
  headline: {
    openCount: number;
    readyCount: number;
    blockedCount: number;
    inFlightCount: number;
    topScore: number;
  };
}

interface FocusViewProps {
  projectId: string;
  onIssueClick: (issueId: string) => void;
}

const PRIORITY_COLOR: Record<string, string> = {
  critical: "#ef4444",
  urgent: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#94a3b8",
};

/** Score → bar colour. High-impact work glows warmer. */
function scoreColor(score: number): string {
  if (score >= 50) return ACCENT;
  if (score >= 35) return BRAND;
  if (score >= 20) return "#c79a3e";
  return "#8a8175";
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

function ReadyRow({ issue, onIssueClick, rank }: { issue: FocusIssue; onIssueClick: (id: string) => void; rank: number }) {
  const barColor = scoreColor(issue.focusScore);
  return (
    <button
      onClick={() => onIssueClick(issue.issueId)}
      className="flex items-center gap-3 text-left group w-full px-3 py-2.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors"
    >
      <span className="shrink-0 w-6 text-center text-xs font-mono text-gray-400 dark:text-gray-500">{rank}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-gray-800 dark:text-gray-100 truncate group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors">
          {issue.issueNumber != null && <span className="text-gray-400 dark:text-gray-500">#{issue.issueNumber} </span>}
          {issue.title}
        </p>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <span className="inline-flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400">
            <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: PRIORITY_COLOR[issue.priority] ?? "#94a3b8" }} />
            {issue.priority}
          </span>
          {issue.estimate && (
            <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">{issue.estimate}</span>
          )}
          {issue.reasons.map((r) => (
            <span key={r} className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300">{r}</span>
          ))}
        </div>
      </div>
      {/* Focus score gauge */}
      <div className="shrink-0 flex flex-col items-end gap-1 w-24">
        <span className="text-xs font-bold tabular-nums" style={{ color: barColor }}>{issue.focusScore}</span>
        <div className="w-full h-1.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
          <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, issue.focusScore)}%`, backgroundColor: barColor }} />
        </div>
      </div>
    </button>
  );
}

function BlockedRow({ issue, onIssueClick }: { issue: FocusIssue; onIssueClick: (id: string) => void }) {
  return (
    <div className="px-3 py-2">
      <button
        onClick={() => onIssueClick(issue.issueId)}
        className="flex items-start gap-2 text-left group w-full"
      >
        <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 bg-red-400" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-gray-700 dark:text-gray-300 truncate group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors">
            {issue.issueNumber != null && <span className="text-gray-400 dark:text-gray-500">#{issue.issueNumber} </span>}
            {issue.title}
          </p>
        </div>
        {issue.unblocks > 0 && (
          <span className="shrink-0 text-[10px] text-gray-400 dark:text-gray-500">unblocks {issue.unblocks}</span>
        )}
      </button>
      {issue.blockedBy.length > 0 && (
        <p className="ml-3.5 mt-0.5 text-[10px] text-gray-400 dark:text-gray-500">
          waiting on{" "}
          {issue.blockedBy.map((b, idx) => (
            <span key={b.issueId}>
              {idx > 0 && ", "}
              <button
                onClick={() => onIssueClick(b.issueId)}
                className="hover:text-brand-500 underline decoration-dotted"
              >
                {b.issueNumber != null ? `#${b.issueNumber}` : b.title}
              </button>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

export function FocusView({ projectId, onIssueClick }: FocusViewProps) {
  const [data, setData] = useState<FocusData | null>(null);
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
    apiFetch<FocusData>(`/api/focus?projectId=${encodeURIComponent(projectId)}`)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load focus");
          setData(null);
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  const h = data?.headline;
  const top = data?.ready[0];

  return (
    <div className="flex-1 min-h-0 overflow-auto px-4 pb-6">
      <div className="max-w-4xl mx-auto space-y-5 pt-3">

        <div>
          <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100">Focus</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">What should I work on next? Ranked by priority, effort, and how much each ticket unblocks.</p>
        </div>

        {loading && <p className="text-sm text-gray-400 dark:text-gray-500">Computing focus…</p>}
        {error && <p className="text-sm text-red-500">{error}</p>}

        {data && h && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Ready" value={h.readyCount} sub="can start now" color={h.readyCount > 0 ? ACCENT : undefined} />
              <StatCard label="Blocked" value={h.blockedCount} sub="waiting on others" color={h.blockedCount > 0 ? "#b4453a" : undefined} />
              <StatCard label="In flight" value={h.inFlightCount} sub="already underway" color={h.inFlightCount > 0 ? BRAND : undefined} />
              <StatCard label="Top score" value={h.topScore} sub="best next pick" color={h.topScore > 0 ? scoreColor(h.topScore) : undefined} />
            </div>

            {/* Hero recommendation */}
            {top && (
              <button
                onClick={() => onIssueClick(top.issueId)}
                className="w-full text-left rounded-xl border border-green-200 dark:border-green-800/60 bg-gradient-to-br from-green-50 to-white dark:from-green-900/20 dark:to-gray-900 p-4 group transition-shadow hover:shadow-md"
              >
                <p className="text-[10px] uppercase tracking-wide font-semibold text-green-600 dark:text-green-400 mb-1">Start here</p>
                <p className="text-base font-semibold text-gray-800 dark:text-gray-100 group-hover:text-green-700 dark:group-hover:text-green-300 transition-colors">
                  {top.issueNumber != null && <span className="text-gray-400 dark:text-gray-500">#{top.issueNumber} </span>}
                  {top.title}
                </p>
                {top.reasons.length > 0 && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{top.reasons.join(" · ")}</p>
                )}
              </button>
            )}

            {data.ready.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 gap-3 text-gray-400 dark:text-gray-500">
                <svg className="w-12 h-12 opacity-25" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-sm">Nothing ready to start — everything open is blocked or in flight.</p>
              </div>
            )}

            {data.ready.length > 0 && (
              <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-2">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 px-2 pt-1 pb-1 flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
                  Ready to start
                  <span className="text-xs font-normal text-gray-400 dark:text-gray-500">({data.ready.length})</span>
                </h3>
                <div className="divide-y divide-gray-100 dark:divide-gray-800">
                  {data.ready.map((issue, idx) => (
                    <ReadyRow key={issue.issueId} issue={issue} onIssueClick={onIssueClick} rank={idx + 1} />
                  ))}
                </div>
              </div>
            )}

            {data.blocked.length > 0 && (
              <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-2">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 px-2 pt-1 pb-1 flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
                  Blocked
                  <span className="text-xs font-normal text-gray-400 dark:text-gray-500">({data.blocked.length})</span>
                </h3>
                <div className="divide-y divide-gray-100 dark:divide-gray-800">
                  {data.blocked.map((issue) => (
                    <BlockedRow key={issue.issueId} issue={issue} onIssueClick={onIssueClick} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
