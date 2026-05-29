import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "../lib/api.js";
import type { StatusWithIssues, IssueWithStatus } from "@agentic-kanban/shared";

interface WorkspaceQueueInfo {
  id: string;
  branch: string;
  workingDir: string | null;
  baseBranch: string;
  repoPath: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  changedFiles: string[];
  status: string;
}

interface OverlapEntry {
  workspaceIdA: string;
  workspaceIdB: string;
  overlapCount: number;
  files: string[];
}

interface MergeQueuePlan {
  order: WorkspaceQueueInfo[];
  overlaps: OverlapEntry[];
  totalOverlapScore: number;
}

type MergeQueueEvent =
  | { type: "planned"; plan: MergeQueuePlan }
  | { type: "rebasing"; workspaceId: string; issueNumber: number | null; issueTitle: string; position: number; total: number }
  | { type: "rebase_ok"; workspaceId: string; issueNumber: number | null; issueTitle: string }
  | { type: "merging"; workspaceId: string; issueNumber: number | null; issueTitle: string; position: number; total: number }
  | { type: "merged"; workspaceId: string; issueNumber: number | null; issueTitle: string }
  | { type: "conflict"; workspaceId: string; issueNumber: number | null; issueTitle: string; conflictingFiles: string[]; error: string }
  | { type: "error"; workspaceId: string; issueNumber: number | null; issueTitle: string; error: string }
  | { type: "skipped"; workspaceId: string; issueNumber: number | null; issueTitle: string; reason: string }
  | { type: "done"; merged: string[]; failed: string[]; skipped: string[] };

type WorkspaceItemStatus = "queued" | "rebasing" | "rebased" | "merging" | "merged" | "conflict" | "error" | "skipped";

interface WorkspaceItemState {
  id: string;
  issueNumber: number | null;
  issueTitle: string;
  branch: string;
  changedFiles: string[];
  status: WorkspaceItemStatus;
  message?: string;
  conflictingFiles?: string[];
}

interface MergeQueuePanelProps {
  columns: StatusWithIssues[];
  projectId: string;
  onClose: () => void;
  onMerged?: () => void;
}

function getStatusIcon(status: WorkspaceItemStatus) {
  switch (status) {
    case "merged": return <span className="text-green-500 font-bold">✓</span>;
    case "rebasing":
    case "merging": return (
      <svg className="w-4 h-4 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
      </svg>
    );
    case "rebased": return <span className="text-blue-500">↺</span>;
    case "conflict": return <span className="text-red-500">✗</span>;
    case "error": return <span className="text-red-400">!</span>;
    case "skipped": return <span className="text-gray-400">⊘</span>;
    case "queued":
    default: return <span className="text-gray-400">⏸</span>;
  }
}

function getStatusColor(status: WorkspaceItemStatus) {
  switch (status) {
    case "merged": return "border-green-200 bg-green-50 dark:bg-green-950/30 dark:border-green-800";
    case "rebasing":
    case "merging": return "border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-800";
    case "rebased": return "border-blue-100 bg-blue-50/50 dark:bg-blue-950/20 dark:border-blue-900";
    case "conflict": return "border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-800";
    case "error": return "border-red-100 bg-red-50/50 dark:bg-red-950/20 dark:border-red-900";
    case "skipped": return "border-gray-200 bg-gray-50 dark:bg-gray-800 dark:border-gray-700";
    default: return "border-gray-200 bg-white dark:bg-gray-900 dark:border-gray-700";
  }
}

export function MergeQueuePanel({ columns, projectId, onClose, onMerged }: MergeQueuePanelProps) {
  const [availableWorkspaces, setAvailableWorkspaces] = useState<WorkspaceItemState[]>([]);
  const [queuedIds, setQueuedIds] = useState<string[]>([]);
  const [plan, setPlan] = useState<MergeQueuePlan | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [itemStates, setItemStates] = useState<Map<string, WorkspaceItemState>>(new Map());
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [skipOnConflict, setSkipOnConflict] = useState(false);
  const [hoveredOverlapPair, setHoveredOverlapPair] = useState<{ a: string; b: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Collect mergeable workspaces from columns
  useEffect(() => {
    const items: WorkspaceItemState[] = [];
    const seen = new Set<string>();
    for (const col of columns) {
      for (const issue of col.issues) {
        const ws = issue.workspaceSummary?.main;
        if (!ws) continue;
        if (seen.has(ws.id)) continue;
        // Include workspaces that are idle, reviewing, or explicitly ready-for-merge
        if (ws.status === "idle" || ws.status === "reviewing" || ws.readyForMerge) {
          seen.add(ws.id);
          items.push({
            id: ws.id,
            issueNumber: issue.issueNumber ?? null,
            issueTitle: issue.title,
            branch: ws.branch,
            changedFiles: [],
            status: "queued",
          });
        }
      }
    }
    setAvailableWorkspaces(items);
  }, [columns]);

  const queuedWorkspaces = queuedIds.flatMap((id) => {
    const state = itemStates.get(id) ?? availableWorkspaces.find((w) => w.id === id);
    return state ? [state] : [];
  });

  function toggleQueue(id: string) {
    setQueuedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return [...prev, id];
    });
    setPlan(null);
  }

  function addAll() {
    setQueuedIds(availableWorkspaces.map((w) => w.id));
    setPlan(null);
  }

  // Drag-and-drop reorder within the queue
  const dragIdRef = useRef<string | null>(null);

  function handleDragStart(e: React.DragEvent, id: string) {
    dragIdRef.current = id;
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(e: React.DragEvent, id: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverId(id);
  }

  function handleDrop(e: React.DragEvent, targetId: string) {
    e.preventDefault();
    setDragOverId(null);
    const srcId = dragIdRef.current;
    if (!srcId || srcId === targetId) return;
    setQueuedIds((prev) => {
      const next = [...prev];
      const srcIdx = next.indexOf(srcId);
      const tgtIdx = next.indexOf(targetId);
      if (srcIdx === -1 || tgtIdx === -1) return prev;
      next.splice(srcIdx, 1);
      next.splice(tgtIdx, 0, srcId);
      return next;
    });
    setPlan(null);
  }

  async function handleAnalyze() {
    if (queuedIds.length === 0) return;
    setIsAnalyzing(true);
    setPlan(null);
    try {
      const result = await apiFetch<{ ok: boolean; plan: MergeQueuePlan }>("/api/merge-queue", {
        method: "POST",
        body: JSON.stringify({ workspaceIds: queuedIds, dryRun: true }),
      });
      setPlan(result.plan);
      // Reorder queue to match suggested order
      setQueuedIds(result.plan.order.map((w) => w.id));
      // Seed changedFiles into item states for display
      setItemStates((prev) => {
        const next = new Map(prev);
        for (const ws of result.plan.order) {
          const existing = next.get(ws.id) ?? availableWorkspaces.find((w) => w.id === ws.id);
          if (existing) {
            next.set(ws.id, { ...existing, changedFiles: ws.changedFiles });
          }
        }
        return next;
      });
    } catch (err) {
      console.error("[merge-queue] analyze failed:", err);
    } finally {
      setIsAnalyzing(false);
    }
  }

  const handleRunQueue = useCallback(async () => {
    if (queuedIds.length === 0 || isRunning) return;
    setIsRunning(true);
    setIsDone(false);
    setPlan(null);

    // Initialize all queued items as "queued"
    setItemStates((prev) => {
      const next = new Map(prev);
      for (const id of queuedIds) {
        const existing = next.get(id) ?? availableWorkspaces.find((w) => w.id === id);
        if (existing) next.set(id, { ...existing, status: "queued" });
      }
      return next;
    });

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const response = await fetch("/api/merge-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceIds: queuedIds, dryRun: false, skipOnConflict }),
        signal: abort.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data) continue;
          try {
            const event = JSON.parse(data) as MergeQueueEvent;
            handleQueueEvent(event);
            if (event.type === "done") {
              setIsRunning(false);
              setIsDone(true);
              if (event.merged.length > 0) onMerged?.();
              return;
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      console.error("[merge-queue] run failed:", err);
    } finally {
      setIsRunning(false);
    }
  }, [queuedIds, skipOnConflict, availableWorkspaces, onMerged]);

  function handleQueueEvent(event: MergeQueueEvent) {
    if (event.type === "planned") {
      setPlan(event.plan);
      setQueuedIds(event.plan.order.map((w) => w.id));
      // Seed initial states
      setItemStates((prev) => {
        const next = new Map(prev);
        for (const ws of event.plan.order) {
          const existing = next.get(ws.id) ?? availableWorkspaces.find((w) => w.id === ws.id);
          if (existing) next.set(ws.id, { ...existing, changedFiles: ws.changedFiles, status: "queued" });
        }
        return next;
      });
      return;
    }

    if (event.type === "done") return;

    setItemStates((prev) => {
      const next = new Map(prev);
      const existing = next.get(event.workspaceId);
      if (!existing) return prev;

      switch (event.type) {
        case "rebasing":
          next.set(event.workspaceId, { ...existing, status: "rebasing" });
          break;
        case "rebase_ok":
          next.set(event.workspaceId, { ...existing, status: "rebased" });
          break;
        case "merging":
          next.set(event.workspaceId, { ...existing, status: "merging" });
          break;
        case "merged":
          next.set(event.workspaceId, { ...existing, status: "merged" });
          break;
        case "conflict":
          next.set(event.workspaceId, {
            ...existing,
            status: "conflict",
            message: event.error,
            conflictingFiles: event.conflictingFiles,
          });
          break;
        case "error":
          next.set(event.workspaceId, { ...existing, status: "error", message: event.error });
          break;
        case "skipped":
          next.set(event.workspaceId, { ...existing, status: "skipped", message: event.reason });
          break;
      }
      return next;
    });
  }

  function handleStop() {
    abortRef.current?.abort();
    setIsRunning(false);
  }

  const getOverlapForPair = (idA: string, idB: string) =>
    plan?.overlaps.find(
      (e) =>
        (e.workspaceIdA === idA && e.workspaceIdB === idB) ||
        (e.workspaceIdA === idB && e.workspaceIdB === idA),
    );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Merge Queue</h2>
            {isDone && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">Done</span>}
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Left: available workspaces */}
          <div className="w-64 border-r border-gray-200 dark:border-gray-700 flex flex-col min-h-0">
            <div className="p-3 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Available</span>
              {availableWorkspaces.length > 0 && (
                <button
                  onClick={addAll}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                  disabled={isRunning}
                >
                  Add all
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
              {availableWorkspaces.length === 0 && (
                <p className="text-xs text-gray-400 dark:text-gray-500 text-center mt-4 px-2">
                  No idle or reviewing workspaces found
                </p>
              )}
              {availableWorkspaces.map((ws) => {
                const inQueue = queuedIds.includes(ws.id);
                return (
                  <button
                    key={ws.id}
                    onClick={() => !isRunning && toggleQueue(ws.id)}
                    disabled={isRunning}
                    className={`w-full text-left p-2 rounded-lg border text-xs transition-colors ${
                      inQueue
                        ? "border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-800 text-blue-700 dark:text-blue-300"
                        : "border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900"
                    } ${isRunning ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
                  >
                    <div className="flex items-center gap-1.5">
                      {inQueue ? (
                        <svg className="w-3.5 h-3.5 text-blue-500 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      ) : (
                        <svg className="w-3.5 h-3.5 text-gray-300 dark:text-gray-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <circle cx="12" cy="12" r="9" />
                        </svg>
                      )}
                      <span className="font-medium truncate">
                        {ws.issueNumber ? `#${ws.issueNumber} ` : ""}{ws.issueTitle}
                      </span>
                    </div>
                    <div className="mt-0.5 text-gray-400 dark:text-gray-500 truncate pl-5">{ws.branch}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right: queue and progress */}
          <div className="flex-1 flex flex-col min-h-0">
            {/* Queue header */}
            <div className="p-3 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Queue ({queuedIds.length})
              </span>
              {plan && (
                <span className={`text-xs px-2 py-0.5 rounded-full ${plan.totalOverlapScore === 0 ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                  {plan.totalOverlapScore === 0 ? "No file overlap" : `${plan.totalOverlapScore} overlapping file${plan.totalOverlapScore === 1 ? "" : "s"}`}
                </span>
              )}
            </div>

            {/* Queue items */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {queuedIds.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-400 dark:text-gray-500">
                  <svg className="w-8 h-8 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                  <p className="text-sm">Select workspaces to queue</p>
                </div>
              )}
              {queuedIds.map((id, idx) => {
                const state = itemStates.get(id) ?? availableWorkspaces.find((w) => w.id === id);
                if (!state) return null;

                // Compute overlaps with already-queued items above
                const overlapsAbove = queuedIds
                  .slice(0, idx)
                  .flatMap((prevId) => {
                    const ov = getOverlapForPair(id, prevId);
                    return ov && ov.overlapCount > 0 ? [ov] : [];
                  });

                return (
                  <div
                    key={id}
                    draggable={!isRunning}
                    onDragStart={(e) => handleDragStart(e, id)}
                    onDragOver={(e) => handleDragOver(e, id)}
                    onDrop={(e) => handleDrop(e, id)}
                    onDragLeave={() => setDragOverId(null)}
                    className={`border rounded-lg p-3 transition-all ${getStatusColor(state.status)} ${
                      dragOverId === id ? "ring-2 ring-blue-400" : ""
                    } ${!isRunning ? "cursor-grab active:cursor-grabbing" : ""}`}
                  >
                    <div className="flex items-start gap-2">
                      {/* drag handle */}
                      {!isRunning && (
                        <svg className="w-3.5 h-3.5 text-gray-300 dark:text-gray-600 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M8 6h2v2H8zm0 5h2v2H8zm0 5h2v2H8zm6-10h2v2h-2zm0 5h2v2h-2zm0 5h2v2h-2z" />
                        </svg>
                      )}
                      <div className="flex items-center gap-1.5 mt-0.5 shrink-0">
                        {getStatusIcon(state.status)}
                        <span className="text-xs text-gray-400">{idx + 1}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">
                          {state.issueNumber ? `#${state.issueNumber} ` : ""}{state.issueTitle}
                        </div>
                        <div className="text-xs text-gray-400 dark:text-gray-500 truncate mt-0.5">
                          {state.branch}
                          {state.changedFiles.length > 0 && (
                            <span className="ml-2 text-gray-300 dark:text-gray-600">
                              {state.changedFiles.length} file{state.changedFiles.length !== 1 ? "s" : ""}
                            </span>
                          )}
                        </div>
                        {state.message && (
                          <div className={`text-xs mt-1 ${state.status === "conflict" || state.status === "error" ? "text-red-600 dark:text-red-400" : "text-gray-400"}`}>
                            {state.message}
                          </div>
                        )}
                        {state.conflictingFiles && state.conflictingFiles.length > 0 && (
                          <div className="text-xs text-red-500 mt-1">
                            Conflicts: {state.conflictingFiles.join(", ")}
                          </div>
                        )}
                        {/* Overlap warnings */}
                        {overlapsAbove.map((ov) => {
                          const otherInfo = queuedWorkspaces.find((w) => w.id === ov.workspaceIdA || w.id === ov.workspaceIdB);
                          const otherId = ov.workspaceIdA === id ? ov.workspaceIdB : ov.workspaceIdA;
                          const other = queuedWorkspaces.find((w) => w.id === otherId);
                          return (
                            <button
                              key={`${ov.workspaceIdA}-${ov.workspaceIdB}`}
                              className="text-xs text-amber-600 dark:text-amber-400 mt-1 hover:underline text-left block"
                              onClick={() => setHoveredOverlapPair(
                                hoveredOverlapPair?.a === ov.workspaceIdA && hoveredOverlapPair.b === ov.workspaceIdB
                                  ? null
                                  : { a: ov.workspaceIdA, b: ov.workspaceIdB }
                              )}
                            >
                              ⚠ {ov.overlapCount} shared file{ov.overlapCount !== 1 ? "s" : ""} with #{other?.issueNumber ?? "?"}
                              {hoveredOverlapPair?.a === ov.workspaceIdA && hoveredOverlapPair.b === ov.workspaceIdB && (
                                <span className="block text-amber-500 dark:text-amber-600 font-mono">
                                  {ov.files.join(", ")}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                      {!isRunning && state.status === "queued" && (
                        <button
                          onClick={() => toggleQueue(id)}
                          className="text-gray-300 hover:text-red-400 transition-colors shrink-0"
                          title="Remove from queue"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer controls */}
            <div className="p-3 border-t border-gray-100 dark:border-gray-800">
              <div className="flex items-center gap-3 mb-3">
                <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={skipOnConflict}
                    onChange={(e) => setSkipOnConflict(e.target.checked)}
                    disabled={isRunning}
                    className="rounded"
                  />
                  Skip on conflict (continue with remaining)
                </label>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleAnalyze}
                  disabled={queuedIds.length === 0 || isAnalyzing || isRunning}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-md transition-colors border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isAnalyzing ? (
                    <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                    </svg>
                  ) : (
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                  )}
                  {isAnalyzing ? "Analyzing…" : "Dry Run"}
                </button>

                {isRunning ? (
                  <button
                    onClick={handleStop}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors bg-red-600 text-white hover:bg-red-700"
                  >
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                      <rect x="6" y="6" width="12" height="12" rx="1" />
                    </svg>
                    Stop
                  </button>
                ) : (
                  <button
                    onClick={handleRunQueue}
                    disabled={queuedIds.length === 0 || isDone}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                    {isDone ? "Done" : "Run Queue"}
                  </button>
                )}

                {isDone && (
                  <button
                    onClick={() => {
                      setIsDone(false);
                      setItemStates(new Map());
                      setQueuedIds([]);
                      setPlan(null);
                    }}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
