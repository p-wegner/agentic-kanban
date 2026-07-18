import { useState } from "react";
import type { TickerEntry } from "../hooks/useAgentLiveTicker.js";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { openSessionTranscript } from "../lib/sessionTranscriptEvents.js";

interface AgentLiveTickerPanelProps {
  entries: TickerEntry[];
  columns: StatusWithIssues[];
  onClose: () => void;
  onWorkspaceClick: (issue: IssueWithStatus, workspaceId: string) => void;
}

const STATUS_DOT: Record<string, string> = {
  active: "bg-emerald-500 animate-pulse",
  fixing: "bg-amber-500 animate-pulse",
};

export function AgentLiveTickerPanel({
  entries,
  columns,
  onClose,
  onWorkspaceClick,
}: AgentLiveTickerPanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  function findIssue(issueId: string): IssueWithStatus | undefined {
    for (const col of columns) {
      const found = col.issues.find((i) => i.id === issueId);
      if (found) return found;
    }
    return undefined;
  }

  const activeEntries = entries.filter(
    (e) => e.workspaceStatus === "active" || e.workspaceStatus === "fixing"
  );

  return (
    <div
      className="fixed bottom-4 right-4 z-40 w-[380px] max-w-[calc(100vw-2rem)] rounded-xl border border-black/[0.08] dark:border-white/10 bg-surface-raised dark:bg-gray-900 shadow-xl overflow-hidden"
      role="complementary"
      aria-label="Agent live activity"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-black/[0.06] dark:border-white/[0.06] bg-surface-sunken dark:bg-gray-800/60">
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
          <span className="text-xs font-semibold text-ink dark:text-gray-200 truncate">
            Live Activity
          </span>
          {activeEntries.length > 0 && (
            <span className="inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded-full bg-brand-600 text-white text-[10px] font-semibold leading-none shrink-0">
              {activeEntries.length}
            </span>
          )}
        </div>
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="shrink-0 flex items-center justify-center w-5 h-5 rounded text-ink-soft dark:text-gray-400 hover:bg-black/[0.06] dark:hover:bg-white/10 transition-colors"
          title={collapsed ? "Expand" : "Collapse"}
          aria-expanded={!collapsed}
        >
          <svg
            className={`w-3 h-3 transition-transform ${collapsed ? "rotate-180" : ""}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <button
          onClick={onClose}
          className="shrink-0 flex items-center justify-center w-5 h-5 rounded text-ink-soft dark:text-gray-400 hover:bg-black/[0.06] dark:hover:bg-white/10 transition-colors"
          title="Close live activity panel"
          aria-label="Close"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      {!collapsed && (
        <div className="max-h-[280px] overflow-y-auto">
          {activeEntries.length === 0 ? (
            <div className="px-3 py-4 text-center">
              <p className="text-xs text-ink-faint dark:text-gray-500">No agents running</p>
            </div>
          ) : (
            <ul className="divide-y divide-black/[0.05] dark:divide-white/[0.05]">
              {activeEntries.map((entry) => {
                const issue = findIssue(entry.issueId);
                return (
                  <li key={entry.workspaceId} className="relative group/entry">
                    {entry.sessionId && (
                      <button
                        onClick={() =>
                          openSessionTranscript({
                            sessionId: entry.sessionId,
                            workspaceId: entry.workspaceId,
                            title: `#${entry.issueNumber ?? ""} ${entry.issueTitle}`,
                          })
                        }
                        className="absolute top-1.5 right-2 z-10 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-ink-soft dark:text-gray-400 bg-surface-raised dark:bg-gray-800 border border-black/[0.06] dark:border-white/10 opacity-0 group-hover/entry:opacity-100 hover:text-brand-600 dark:hover:text-brand-400 transition-opacity"
                        title="Open full transcript"
                      >
                        📜 Transcript
                      </button>
                    )}
                    <button
                      className="w-full text-left px-3 py-2 hover:bg-surface-sunken dark:hover:bg-gray-800/60 transition-colors group"
                      onClick={() => {
                        if (issue) onWorkspaceClick(issue, entry.workspaceId);
                      }}
                      disabled={!issue}
                      title={`Open workspace for #${entry.issueNumber ?? ""} ${entry.issueTitle}`}
                    >
                      {/* Issue line */}
                      <div className="flex items-center gap-1.5 mb-1 min-w-0">
                        <span
                          className={`shrink-0 w-1.5 h-1.5 rounded-full ${STATUS_DOT[entry.workspaceStatus] ?? "bg-gray-400"}`}
                        />
                        <span className="text-[11px] font-medium text-ink-soft dark:text-gray-400 shrink-0">
                          {entry.issueNumber != null ? `#${entry.issueNumber}` : ""}
                        </span>
                        <span className="text-[11px] font-semibold text-ink dark:text-gray-200 truncate flex-1">
                          {entry.issueTitle}
                        </span>
                        <svg
                          className="w-3 h-3 shrink-0 text-ink-faint dark:text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </div>
                      {/* Output lines */}
                      {entry.lines.length > 0 ? (
                        <div className="pl-3 space-y-0.5">
                          {entry.lines.map((line, i) => (
                            <p
                              key={i}
                              className="text-[11px] font-mono text-ink-soft dark:text-gray-400 truncate leading-tight"
                              title={line}
                            >
                              {line}
                            </p>
                          ))}
                        </div>
                      ) : (
                        <p className="pl-3 text-[11px] text-ink-faint dark:text-gray-600 italic">
                          Waiting for output...
                        </p>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
