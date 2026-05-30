import { useState, useEffect, useRef } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";

const STORAGE_KEY = "backlog-panel-open";

const issueTypeColors: Record<string, string> = {
  task: "bg-gray-200 text-gray-600",
  bug: "bg-red-100 text-red-700",
  feature: "bg-blue-100 text-blue-700",
  chore: "bg-amber-100 text-amber-700",
};

interface BacklogPanelProps {
  backlogColumn: StatusWithIssues | undefined;
  activeColumns: StatusWithIssues[];
  searchQuery?: string;
  onIssueClick: (issue: IssueWithStatus) => void;
  onMoved: () => void;
}

function usePersisted(key: string, defaultValue: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? stored === "true" : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  function set(v: boolean) {
    setValue(v);
    try { localStorage.setItem(key, String(v)); } catch {}
  }

  return [value, set];
}

export function BacklogPanel({ backlogColumn, activeColumns, searchQuery, onIssueClick, onMoved }: BacklogPanelProps) {
  const [open, setOpen] = usePersisted(STORAGE_KEY, false);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [pickerIssueId, setPickerIssueId] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const backlogCount = backlogColumn?.issues.length ?? 0;

  const filteredIssues = backlogColumn?.issues.filter((issue) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return issue.title.toLowerCase().includes(q) || (issue.description?.toLowerCase().includes(q) ?? false);
  }) ?? [];

  useEffect(() => {
    if (!pickerIssueId) return;
    function handler(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerIssueId(null);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickerIssueId]);

  async function moveToStatus(issue: IssueWithStatus, statusId: string) {
    setMovingId(issue.id);
    setPickerIssueId(null);
    try {
      await apiFetch(`/api/issues/${issue.id}`, {
        method: "PATCH",
        body: JSON.stringify({ statusId }),
      });
      onMoved();
      showToast("Issue moved", "success");
    } catch {
      showToast("Failed to move issue", "error");
    } finally {
      setMovingId(null);
    }
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    if (!backlogColumn) return;
    const raw = (window as unknown as Record<string, unknown>).__dragData;
    if (!raw || typeof raw !== "object") return;
    const { issueId } = raw as { issueId: string };
    if (!issueId) return;
    setMovingId(issueId);
    try {
      await apiFetch(`/api/issues/${issueId}`, {
        method: "PATCH",
        body: JSON.stringify({ statusId: backlogColumn.id }),
      });
      onMoved();
      showToast("Issue moved to Backlog", "success");
    } catch {
      showToast("Failed to move issue", "error");
    } finally {
      setMovingId(null);
    }
  }

  return (
    <>
      {/* Toggle button — always visible */}
      <button
        onClick={() => setOpen(!open)}
        title={open ? "Collapse backlog" : "Open backlog"}
        className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${
          open
            ? "bg-brand-600 border-brand-600 text-white hover:bg-brand-700"
            : "bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
        }`}
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path d="M3 6h18M3 10h18M3 14h10M3 18h10" />
        </svg>
        Backlog
        {backlogCount > 0 && (
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none ${open ? "bg-brand-500 text-white" : "bg-surface-sunken dark:bg-gray-800 text-ink-soft dark:text-gray-400"}`}>
            {backlogCount}
          </span>
        )}
      </button>

      {/* Side panel */}
      {open && (
        <div
          className="fixed right-0 top-0 h-full w-72 bg-surface-raised dark:bg-surface-raised-dark border-l border-black/[0.07] dark:border-white/10 shadow-xl z-30 flex flex-col"
          style={{ animation: "slide-in-right 0.2s ease-out" }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800 shrink-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-ink dark:text-gray-200">Backlog</span>
              {backlogCount > 0 && (
                <span className="bg-brand-100 text-brand-700 rounded-full px-2 py-0.5 text-xs font-medium">
                  {backlogCount}
                </span>
              )}
            </div>
            <button
              onClick={() => setOpen(false)}
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors p-1 rounded"
              title="Close"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Drop hint */}
          <div className="mx-3 mt-2 px-2 py-1.5 rounded border border-dashed border-gray-200 dark:border-gray-700 text-center text-[10px] text-gray-400 dark:text-gray-500 shrink-0">
            Drop issues here to move to Backlog
          </div>

          {/* Issue list */}
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
            {filteredIssues.length === 0 ? (
              <div className="text-center text-gray-400 dark:text-gray-500 text-sm mt-8">
                {searchQuery ? "No matching backlog issues" : "Backlog is empty"}
              </div>
            ) : (
              filteredIssues.map((issue) => (
                <div
                  key={issue.id}
                  className="bg-gray-50 dark:bg-gray-950 rounded-lg p-2.5 border border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 transition-colors cursor-pointer select-none"
                  onClick={() => onIssueClick(issue)}
                  draggable
                  onDragStart={(e) => {
                    (window as unknown as Record<string, unknown>).__dragData = {
                      issueId: issue.id,
                      sourceStatusId: issue.statusId,
                    };
                    e.dataTransfer.effectAllowed = "move";
                  }}
                >
                  <div className="flex items-start justify-between gap-1.5">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-[10px] text-gray-400 dark:text-gray-500 font-mono shrink-0">#{issue.issueNumber}</span>
                        {issue.issueType && issue.issueType !== "task" && (
                          <span className={`text-[10px] px-1 rounded font-medium capitalize ${issueTypeColors[issue.issueType] ?? "bg-gray-100 text-gray-600"}`}>
                            {issue.issueType}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-800 dark:text-gray-200 font-medium leading-snug line-clamp-2">{issue.title}</p>
                    </div>

                    {/* Move button */}
                    <div className="relative shrink-0" ref={pickerIssueId === issue.id ? pickerRef : undefined}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setPickerIssueId(pickerIssueId === issue.id ? null : issue.id);
                        }}
                        disabled={movingId === issue.id}
                        className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors disabled:opacity-50"
                        title="Move to status"
                      >
                        {movingId === issue.id ? (
                          <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                            <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        ) : (
                          <>
                            Move
                            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path d="M19 9l-7 7-7-7" />
                            </svg>
                          </>
                        )}
                      </button>

                      {pickerIssueId === issue.id && (
                        <div className="absolute right-0 top-full mt-1 z-50 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 min-w-[130px]">
                          {activeColumns.map((col) => (
                            <button
                              key={col.id}
                              className="w-full text-left px-3 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                              onClick={(e) => {
                                e.stopPropagation();
                                moveToStatus(issue, col.id);
                              }}
                            >
                              {col.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}
