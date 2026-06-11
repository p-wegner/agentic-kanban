import { useEffect, useState } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import {
  DEPENDENCY_COLORS,
  DEPENDENCY_TYPE_LABELS,
  type Dependency,
  type DependencyType,
} from "../lib/graphLayout.js";

interface EdgeEditPanelProps {
  edge: Dependency;
  sourceIssue: IssueWithStatus | null;
  targetIssue: IssueWithStatus | null;
  onClose: () => void;
  onRemove: (edgeId: string) => Promise<void>;
  onTypeChange: (edgeId: string, newType: DependencyType) => Promise<void>;
}

export function EdgeEditPanel({ edge, sourceIssue, targetIssue, onClose, onRemove, onTypeChange }: EdgeEditPanelProps) {
  const [removing, setRemoving] = useState(false);
  const [typeChanging, setTypeChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  async function handleRemove() {
    setRemoving(true);
    setError(null);
    try {
      await onRemove(edge.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove dependency");
      setRemoving(false);
    }
  }

  async function handleTypeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const newType = e.target.value as DependencyType;
    if (newType === edge.type) return;
    setTypeChanging(true);
    setError(null);
    try {
      await onTypeChange(edge.id, newType);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update dependency type");
    } finally {
      setTypeChanging(false);
    }
  }

  const edgeColor = DEPENDENCY_COLORS[edge.type] ?? "#9ca3af";

  return (
    <div
      className="absolute z-30 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3"
      style={{ bottom: 60, left: "50%", transform: "translateX(-50%)", minWidth: 320, maxWidth: 420 }}
      data-testid="edge-edit-panel"
    >
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Edit Dependency</h3>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 px-1"
          aria-label="Close edge editor"
        >✕</button>
      </div>

      {/* Source → Target */}
      <div className="flex items-center gap-2 mb-3 text-xs">
        <div className="flex-1 min-w-0 rounded px-2 py-1.5 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
          <div className="text-[10px] text-gray-400 mb-0.5">Source</div>
          <div className="font-medium text-gray-800 dark:text-gray-200 truncate" title={sourceIssue?.title ?? edge.dependsOnId}>
            {sourceIssue?.issueNumber != null && <span className="font-mono text-gray-400 mr-1">#{sourceIssue.issueNumber}</span>}
            {sourceIssue?.title ?? edge.dependsOnId}
          </div>
        </div>
        <div className="flex flex-col items-center shrink-0">
          <svg width="24" height="16" viewBox="0 0 24 16">
            <path d="M2,8 L18,8 M14,4 L19,8 L14,12" stroke={edgeColor} strokeWidth="1.5" fill="none" />
          </svg>
        </div>
        <div className="flex-1 min-w-0 rounded px-2 py-1.5 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
          <div className="text-[10px] text-gray-400 mb-0.5">Target</div>
          <div className="font-medium text-gray-800 dark:text-gray-200 truncate" title={targetIssue?.title ?? edge.issueId}>
            {targetIssue?.issueNumber != null && <span className="font-mono text-gray-400 mr-1">#{targetIssue.issueNumber}</span>}
            {targetIssue?.title ?? edge.issueId}
          </div>
        </div>
      </div>

      {/* Dependency type selector */}
      <div className="mb-3">
        <label className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide block mb-1">
          Dependency Type
        </label>
        <select
          value={edge.type}
          onChange={handleTypeChange}
          disabled={typeChanging}
          className="w-full text-xs border border-gray-200 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200"
          aria-label="Dependency type"
        >
          {(Object.keys(DEPENDENCY_TYPE_LABELS) as DependencyType[]).map((t) => (
            <option key={t} value={t}>{DEPENDENCY_TYPE_LABELS[t]}</option>
          ))}
        </select>
      </div>

      {error && (
        <div className="text-xs text-red-600 dark:text-red-400 mb-2 px-1" role="alert">{error}</div>
      )}

      <button
        onClick={handleRemove}
        disabled={removing}
        className="w-full text-xs px-3 py-1.5 rounded bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800 transition-colors disabled:opacity-60"
        aria-label="Remove dependency"
      >
        {removing ? "Removing…" : "Remove Dependency"}
      </button>
    </div>
  );
}
