import React, { useRef, useState } from "react";
import type { DependencyInfo, IssueWithStatus } from "@agentic-kanban/shared";
import { apiFetch, apiPost, apiDelete } from "../lib/api.js";
import { showToast } from "./Toast.js";

interface DependencyDisplayProps {
  issue: IssueWithStatus;
  dependencies: DependencyInfo;
  setDependencies: React.Dispatch<React.SetStateAction<DependencyInfo>>;
  availableIssues: IssueWithStatus[];
  onIssueUpdate: (issue: IssueWithStatus) => void;
  onNavigateToIssue?: (issueId: string) => void;
  /** Navigate to the graph view and focus this issue. */
  onViewInGraph?: (issueId: string) => void;
}

export function DependencyDisplay({
  issue,
  dependencies,
  setDependencies,
  availableIssues,
  onIssueUpdate,
  onNavigateToIssue,
  onViewInGraph,
}: DependencyDisplayProps) {
  const depTypeRef = useRef<HTMLSelectElement>(null);
  const [depSearch, setDepSearch] = useState("");
  const [depDropdownOpen, setDepDropdownOpen] = useState(false);
  const [depHighlightIdx, setDepHighlightIdx] = useState(0);
  const depComboRef = useRef<HTMLDivElement>(null);
  const depInputRef = useRef<HTMLInputElement>(null);
  const [analyzingDeps, setAnalyzingDeps] = useState(false);

  async function handleAnalyzeDeps() {
    if (analyzingDeps) return;
    setAnalyzingDeps(true);
    try {
      const result = await apiPost<{ dependencies: Array<{ id: string; type: string; issueId: string; reason: string }>; total: number }>("/api/issues/analyze-dependencies", { issueId: issue.id, projectId: issue.projectId });
      // Reload dependencies to show newly created ones
      const deps = await apiFetch<DependencyInfo>(`/api/issues/${issue.id}/dependencies`);
      setDependencies(deps);
      if (result.total > 0) {
        showToast(`Added ${result.total} dependenc${result.total === 1 ? "y" : "ies"}`, "success");
      } else {
        showToast("No new dependencies found");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Dependency analysis failed", "error");
    } finally {
      setAnalyzingDeps(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
          Dependencies
        </label>
        <div className="flex items-center gap-1">
          {onViewInGraph && dependencies.dependencies.length > 0 && (
            <button
              onClick={() => onViewInGraph(issue.id)}
              className="text-[10px] text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 font-medium px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-1"
              title="View in dependency graph"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="5" cy="12" r="2" />
                <circle cx="19" cy="5" r="2" />
                <circle cx="19" cy="19" r="2" />
                <path d="M7 12h6M15 6.5l-4 4M15 17.5l-4-4" />
              </svg>
              Graph
            </button>
          )}
          <button
            onClick={handleAnalyzeDeps}
            disabled={analyzingDeps}
            className="text-[10px] text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300 font-medium px-1.5 py-0.5 rounded border border-brand-200 dark:border-brand-700 hover:bg-brand-50 dark:hover:bg-brand-900/40 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
            title="Analyze dependencies with AI"
          >
            {analyzingDeps && (
              <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
            )}
            {analyzingDeps ? "Analyzing..." : "Analyze Deps"}
          </button>
        </div>
      </div>
      {dependencies.dependencies.length > 0 ? (
        <div className="space-y-1.5">
          {(() => {
            // Compute effective display type based on direction
            // For incoming deps, we show the inverse perspective
            type DisplayCategory = "depends_on" | "blocked_by" | "blocking" | "child_of" | "parent_of" | "related_to" | "duplicates";

            function getDisplayType(dep: typeof dependencies.dependencies[number]): DisplayCategory {
              const isOutgoing = dep.issueId === issue.id;
              if (isOutgoing) {
                // Outgoing: use the type as-is (but depends_on stays depends_on, blocked_by stays blocked_by)
                return dep.type;
              }
              // Incoming: invert
              switch (dep.type) {
                case "depends_on": return "blocking";    // someone depends on me = I'm blocking them
                case "blocked_by": return "blocking";   // someone blocked by me = I'm blocking them
                case "parent_of": return "child_of";    // someone is my parent = I'm their child
                case "child_of": return "parent_of";    // someone is my child = I'm their parent
                case "related_to": return "related_to";
                case "duplicates": return "duplicates";
                default: return "related_to";
              }
            }

            const DISPLAY_LABELS: Record<DisplayCategory, string> = {
              depends_on: "Depends on",
              blocked_by: "Blocked by",
              blocking: "Blocking",
              related_to: "Related to",
              duplicates: "Duplicates",
              parent_of: "Parent of",
              child_of: "Child of",
            };

            type DepWithDisplay = typeof dependencies.dependencies[number] & { displayType: DisplayCategory };
            const depsWithDisplay: DepWithDisplay[] = dependencies.dependencies.map((dep) => ({
              ...dep,
              displayType: getDisplayType(dep),
            }));

            // Group by display type
            const byDisplayType = new Map<DisplayCategory, DepWithDisplay[]>();
            for (const dep of depsWithDisplay) {
              const list = byDisplayType.get(dep.displayType) ?? [];
              list.push(dep);
              byDisplayType.set(dep.displayType, list);
            }

            const typeOrder: DisplayCategory[] = ["depends_on", "blocked_by", "blocking", "child_of", "parent_of", "related_to", "duplicates"];
            const typeColors: Record<DisplayCategory, string> = {
              depends_on: "bg-blue-50 text-blue-700",
              blocked_by: "bg-red-50 text-red-700",
              blocking: "bg-orange-50 text-orange-700",
              related_to: "bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300",
              duplicates: "bg-yellow-50 text-yellow-700",
              parent_of: "bg-green-50 text-green-700",
              child_of: "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300",
            };
            return typeOrder
              .filter((t) => byDisplayType.has(t))
              .map((t) => (
                <div key={t}>
                  <span className="text-xs text-gray-500 dark:text-gray-400 block mb-0.5">
                    {DISPLAY_LABELS[t]}:
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {byDisplayType.get(t)!.map((dep) => {
                      const isOutgoing = dep.issueId === issue.id;
                      const targetIssueId = isOutgoing ? dep.dependsOnId : dep.issueId;
                      const showBlockingDot = dep.issueStatusName !== "Done" && dep.issueStatusName !== "AI Reviewed" &&
                        (dep.displayType === "depends_on" || dep.displayType === "blocked_by" || dep.displayType === "child_of");
                      return (
                        <span
                          key={dep.id}
                          className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full cursor-pointer hover:opacity-80 ${typeColors[t]}`}
                          onClick={() => onNavigateToIssue?.(targetIssueId)}
                          title={`#${dep.issueNumber ?? ""} ${dep.issueTitle}`}
                        >
                          {showBlockingDot && (
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                          )}
                          {!showBlockingDot && dep.issueStatusName !== "Done" && dep.issueStatusName !== "AI Reviewed" && (
                            <span className="w-1.5 h-1.5 rounded-full bg-gray-300 dark:bg-gray-600 shrink-0" />
                          )}
                          {(dep.issueStatusName === "Done" || dep.issueStatusName === "AI Reviewed") && (
                            <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                          )}
                          <span className="truncate max-w-[120px]">{dep.issueTitle}</span>
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                await apiDelete(`/api/issues/${issue.id}/dependencies/${dep.id}`);
                                setDependencies((prev) => ({
                                  dependencies: prev.dependencies.filter((d) => d.id !== dep.id),
                                }));
                                onIssueUpdate(issue);
                              } catch {
                                showToast("Failed to remove dependency", "error");
                              }
                            }}
                            className="opacity-50 hover:opacity-100"
                          >
                            &times;
                          </button>
                        </span>
                      );
                    })}
                  </div>
                </div>
              ));
          })()}
        </div>
      ) : null}
      {(() => {
        const existingTargetIds = new Set(
          dependencies.dependencies
            .filter((d) => d.issueId === issue.id)
            .map((d) => d.dependsOnId)
        );
        const candidates = availableIssues.filter((i) => !existingTargetIds.has(i.id));
        const filteredCandidates = candidates.filter((i) => {
          const q = depSearch.toLowerCase();
          return (
            (i.issueNumber != null && String(i.issueNumber).includes(q)) ||
            i.title.toLowerCase().includes(q)
          );
        });
        const addDep = async (depId: string) => {
          const depType = depTypeRef.current?.value || "depends_on";
          try {
            await apiPost(`/api/issues/${issue.id}/dependencies`, { dependsOnId: depId, type: depType });
            const deps = await apiFetch<DependencyInfo>(`/api/issues/${issue.id}/dependencies`);
            setDependencies(deps);
            onIssueUpdate(issue);
            setDepSearch("");
            setDepDropdownOpen(false);
            setDepHighlightIdx(0);
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Failed to add dependency";
            showToast(msg, "error");
          }
        };
        return candidates.length > 0 ? (
          <div className="flex gap-1 mt-1.5">
            <div ref={depComboRef} className="relative">
              <input
                ref={depInputRef}
                type="text"
                className="text-xs border border-gray-300 dark:border-gray-600 rounded px-1.5 py-0.5 w-44 focus:outline-none focus:ring-1 focus:ring-brand-500"
                placeholder="+ Add dependency…"
                value={depSearch}
                onChange={(e) => {
                  setDepSearch(e.target.value);
                  setDepDropdownOpen(true);
                  setDepHighlightIdx(0);
                }}
                onFocus={() => setDepDropdownOpen(true)}
                onBlur={(e) => {
                  if (!depComboRef.current?.contains(e.relatedTarget)) {
                    setDepDropdownOpen(false);
                  }
                }}
                onKeyDown={(e) => {
                  if (!depDropdownOpen) {
                    if (e.key === "ArrowDown" || e.key === "Enter") setDepDropdownOpen(true);
                    return;
                  }
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setDepHighlightIdx((p) => Math.min(p + 1, filteredCandidates.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setDepHighlightIdx((p) => Math.max(p - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    const item = filteredCandidates[depHighlightIdx];
                    if (item) void addDep(item.id);
                  } else if (e.key === "Escape") {
                    setDepDropdownOpen(false);
                    setDepSearch("");
                  }
                }}
              />
              {depDropdownOpen && (
                <div className="absolute z-50 top-full left-0 mt-0.5 w-64 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded shadow-lg max-h-48 overflow-y-auto">
                  {filteredCandidates.length === 0 ? (
                    <div className="text-xs text-gray-400 dark:text-gray-500 px-2 py-1.5">No matches</div>
                  ) : (
                    filteredCandidates.map((i, idx) => (
                      <button
                        key={i.id}
                        tabIndex={-1}
                        className={`w-full text-left text-xs px-2 py-1 truncate ${idx === depHighlightIdx ? "bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-300" : "hover:bg-gray-100 dark:hover:bg-gray-800"}`}
                        onMouseDown={(e) => { e.preventDefault(); void addDep(i.id); }}
                        onMouseEnter={() => setDepHighlightIdx(idx)}
                      >
                        {i.issueNumber != null ? <span className="font-mono text-gray-500 dark:text-gray-400">#{i.issueNumber} </span> : null}
                        {i.title}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <select
              ref={depTypeRef}
              className="text-xs border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
              defaultValue="depends_on"
            >
              <option value="depends_on">depends on</option>
              <option value="blocked_by">blocked by</option>
              <option value="related_to">related to</option>
              <option value="duplicates">duplicates</option>
              <option value="parent_of">parent of</option>
              <option value="child_of">child of</option>
            </select>
          </div>
        ) : null;
      })()}
    </div>
  );
}
