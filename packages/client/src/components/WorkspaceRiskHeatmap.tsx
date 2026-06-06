import { useState, useEffect } from "react";
import { apiFetch } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { CollapsibleSection } from "./CollapsibleSection.js";

type RiskLevel = "high" | "medium" | "low" | "none";

interface RiskSignal {
  key: string;
  label: string;
  value: string | number | boolean | null;
  severity: "high" | "medium" | "low" | "none";
  detail?: string;
}

interface WorkspaceRiskEntry {
  workspaceId: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  issueStatusName: string;
  branch: string;
  workspaceStatus: string;
  riskLevel: RiskLevel;
  riskScore: number;
  signals: RiskSignal[];
  changedFiles: string[];
}

interface WorkspaceRiskResponse {
  projectId: string;
  generatedAt: string;
  entries: WorkspaceRiskEntry[];
}

interface WorkspaceRiskHeatmapProps {
  projectId: string;
  onIssueClick: (issue: IssueWithStatus) => void;
}

const RISK_COLORS: Record<RiskLevel, { row: string; badge: string; label: string }> = {
  high: {
    row: "border-l-4 border-l-red-500 bg-red-50/40 dark:bg-red-900/10",
    badge: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
    label: "High",
  },
  medium: {
    row: "border-l-4 border-l-amber-400 bg-amber-50/40 dark:bg-amber-900/10",
    badge: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
    label: "Medium",
  },
  low: {
    row: "border-l-4 border-l-yellow-300 bg-yellow-50/30 dark:bg-yellow-900/10",
    badge: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-200",
    label: "Low",
  },
  none: {
    row: "border-l-4 border-l-gray-200 dark:border-l-gray-700",
    badge: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
    label: "Clean",
  },
};

const SIGNAL_SEVERITY_COLORS: Record<string, string> = {
  high: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  low: "bg-yellow-100 text-yellow-600 dark:bg-yellow-900/40 dark:text-yellow-300",
  none: "bg-gray-100 text-gray-500",
};

const SIGNAL_ICONS: Record<string, string> = {
  conflicts: "⚡",
  age: "🕐",
  uncommitted: "📝",
  failures: "❌",
  questions: "❓",
  overlap: "🔀",
};

type RiskFilter = "all" | "high" | "medium" | "low";

export function WorkspaceRiskHeatmap({ projectId, onIssueClick }: WorkspaceRiskHeatmapProps) {
  const [data, setData] = useState<WorkspaceRiskResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiFetch<WorkspaceRiskResponse>(`/api/projects/${projectId}/workspace-risk`)
      .then((d) => setData(d))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [projectId]);

  const allStatuses = data
    ? [...new Set(data.entries.map((e) => e.issueStatusName))]
    : [];

  const filtered = (data?.entries ?? []).filter((entry) => {
    if (riskFilter !== "all" && entry.riskLevel !== riskFilter) return false;
    if (statusFilter !== "all" && entry.issueStatusName !== statusFilter) return false;
    return true;
  });

  const counts: Record<RiskLevel | "all", number> = {
    all: data?.entries.length ?? 0,
    high: data?.entries.filter((e) => e.riskLevel === "high").length ?? 0,
    medium: data?.entries.filter((e) => e.riskLevel === "medium").length ?? 0,
    low: data?.entries.filter((e) => e.riskLevel === "low").length ?? 0,
    none: data?.entries.filter((e) => e.riskLevel === "none").length ?? 0,
  };

  if (loading) {
    return (
      <div className="px-4 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
        Loading risk heatmap…
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      </div>
    );
  }

  if (!data || data.entries.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-sm text-gray-500 dark:text-gray-400">
        No active or review workspaces to analyze.
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Filters */}
      <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
        <CollapsibleSection
          title="Filters"
          defaultOpen
          summary={`${riskFilter === "all" ? "All risk" : `${riskFilter.charAt(0).toUpperCase()}${riskFilter.slice(1)} risk`}${statusFilter !== "all" ? ` · ${statusFilter}` : ""}`}
        >
        <div className="space-y-2">
        {/* Risk level filter chips */}
        <div className="flex gap-1.5 flex-wrap">
          {(["all", "high", "medium", "low"] as const).map((level) => (
            <button
              key={level}
              onClick={() => setRiskFilter(level)}
              className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${
                riskFilter === level
                  ? level === "high"
                    ? "bg-red-600 text-white"
                    : level === "medium"
                      ? "bg-amber-500 text-white"
                      : level === "low"
                        ? "bg-yellow-400 text-gray-900"
                        : "bg-brand-600 text-white"
                  : level === "high"
                    ? "bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50"
                    : level === "medium"
                      ? "bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400 hover:bg-amber-100"
                      : level === "low"
                        ? "bg-yellow-50 text-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-400 hover:bg-yellow-100"
                        : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
              }`}
            >
              {level === "all" ? `All (${counts.all})` : `${level.charAt(0).toUpperCase() + level.slice(1)} (${counts[level as RiskLevel]})`}
            </button>
          ))}
        </div>
        {/* Status filter */}
        {allStatuses.length > 1 && (
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-xs px-2.5 py-1 border border-gray-200 dark:border-gray-700 rounded-md bg-white dark:bg-gray-900 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-400"
          >
            <option value="all">All statuses</option>
            {allStatuses.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        )}
        </div>
        </CollapsibleSection>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-gray-500 dark:text-gray-400">
            No workspaces match the current filter.
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {filtered.map((entry) => {
              const riskMeta = RISK_COLORS[entry.riskLevel];
              return (
                <div
                  key={entry.workspaceId}
                  className={`px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/60 cursor-pointer ${riskMeta.row}`}
                  onClick={() =>
                    onIssueClick({
                      id: entry.issueId,
                      issueNumber: entry.issueNumber,
                      title: entry.issueTitle,
                      statusName: entry.issueStatusName,
                    } as IssueWithStatus)
                  }
                >
                  {/* Issue title row */}
                  <div className="flex items-start gap-2 mb-1.5">
                    <span className="text-xs text-gray-400 dark:text-gray-500 font-mono mt-0.5 shrink-0">
                      #{entry.issueNumber}
                    </span>
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100 flex-1 min-w-0 line-clamp-1">
                      {entry.issueTitle}
                    </span>
                    <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 font-medium ${riskMeta.badge}`}>
                      {riskMeta.label}
                    </span>
                  </div>

                  {/* Branch + status */}
                  <div className="flex items-center gap-2 flex-wrap ml-6 mb-2">
                    <span className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate max-w-[180px]">
                      {entry.branch}
                    </span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
                      {entry.workspaceStatus}
                    </span>
                    <span className="text-xs text-gray-400 dark:text-gray-500">
                      {entry.issueStatusName}
                    </span>
                  </div>

                  {/* Risk signals */}
                  {entry.signals.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 ml-6">
                      {entry.signals.map((signal) => (
                        <span
                          key={signal.key}
                          className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${SIGNAL_SEVERITY_COLORS[signal.severity] ?? SIGNAL_SEVERITY_COLORS.none}`}
                          title={signal.detail}
                        >
                          {SIGNAL_ICONS[signal.key] ?? "•"} {signal.label}
                          {signal.value !== null && signal.value !== undefined && typeof signal.value === "number"
                            ? `: ${signal.value}`
                            : ""}
                        </span>
                      ))}
                    </div>
                  )}

                  {entry.signals.length === 0 && (
                    <div className="ml-6 text-xs text-gray-400 dark:text-gray-500 italic">
                      No risk signals
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer: generation time */}
      {data?.generatedAt && (
        <div className="px-4 py-1.5 border-t border-gray-100 dark:border-gray-800 flex-shrink-0">
          <span className="text-[11px] text-gray-400 dark:text-gray-500">
            Updated {formatRelativeTime(data.generatedAt)}
          </span>
        </div>
      )}
    </div>
  );
}
