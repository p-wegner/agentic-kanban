import { useEffect, useState } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { DEPENDENCY_TYPE_LABELS, type DependencyType } from "../lib/graphLayout.js";

interface AddEdgePanelProps {
  sourceIssue: IssueWithStatus | null;
  allIssues: IssueWithStatus[];
  projectId: string;
  onAdd: (sourceId: string, targetId: string, type: DependencyType) => Promise<void>;
  onCancel: () => void;
}

export function AddEdgePanel({ sourceIssue, allIssues, projectId: _projectId, onAdd, onCancel }: AddEdgePanelProps) {
  const [targetId, setTargetId] = useState("");
  const [depType, setDepType] = useState<DependencyType>("depends_on");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  async function handleAdd() {
    if (!sourceIssue || !targetId) return;
    setAdding(true);
    setError(null);
    try {
      await onAdd(sourceIssue.id, targetId, depType);
      onCancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add dependency");
      setAdding(false);
    }
  }

  const otherIssues = allIssues.filter((i) => i.id !== sourceIssue?.id);

  return (
    <div
      className="absolute z-30 bg-white dark:bg-gray-900 border border-blue-200 dark:border-blue-700 rounded-lg shadow-lg p-3"
      style={{ bottom: 60, left: "50%", transform: "translateX(-50%)", minWidth: 340, maxWidth: 440 }}
      data-testid="add-edge-panel"
    >
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Add Dependency</h3>
        <button
          onClick={onCancel}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 px-1"
          aria-label="Cancel add dependency"
        >✕</button>
      </div>

      <div className="space-y-2 mb-3">
        <div>
          <label className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide block mb-1">
            Source Issue
          </label>
          <div className="text-xs px-2 py-1.5 rounded bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-200">
            {sourceIssue ? (
              <>
                {sourceIssue.issueNumber != null && <span className="font-mono text-gray-400 mr-1">#{sourceIssue.issueNumber}</span>}
                {sourceIssue.title}
              </>
            ) : <span className="text-gray-400">Select a source node on the graph</span>}
          </div>
        </div>

        <div>
          <label className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide block mb-1">
            Type
          </label>
          <select
            value={depType}
            onChange={(e) => setDepType(e.target.value as DependencyType)}
            className="w-full text-xs border border-gray-200 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200"
            aria-label="New dependency type"
          >
            {(Object.keys(DEPENDENCY_TYPE_LABELS) as DependencyType[]).map((t) => (
              <option key={t} value={t}>{DEPENDENCY_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide block mb-1">
            Target Issue
          </label>
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="w-full text-xs border border-gray-200 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200"
            aria-label="Target issue"
          >
            <option value="">— select target —</option>
            {otherIssues.map((i) => (
              <option key={i.id} value={i.id}>
                {i.issueNumber != null ? `#${i.issueNumber} ` : ""}{i.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="text-xs text-red-600 dark:text-red-400 mb-2 px-1" role="alert" data-testid="add-edge-error">{error}</div>
      )}

      <div className="flex gap-2">
        <button
          onClick={handleAdd}
          disabled={adding || !sourceIssue || !targetId}
          className="flex-1 text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-60"
          aria-label="Confirm add dependency"
        >
          {adding ? "Adding…" : "Add Dependency"}
        </button>
        <button
          onClick={onCancel}
          className="text-xs px-3 py-1.5 rounded border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
