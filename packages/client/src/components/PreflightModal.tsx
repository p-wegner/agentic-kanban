import { useState } from "react";
import { apiFetch } from "../lib/api.js";

export type PreflightVerdict = "ready" | "needs-clarification" | string;

export interface PreflightResult {
  verdict: PreflightVerdict;
  questions: string[];
  summary: string;
  duplicateOfNumber?: number;
  blockedByNumber?: number;
}

interface PreflightModalProps {
  result: PreflightResult;
  issueId: string;
  projectId: string;
  issueTitle: string;
  issueDescription: string;
  onLaunchAnyway: () => void;
  onRetry: (updatedTitle: string, updatedDescription: string) => void;
  onCancel: () => void;
  /** True while a re-check is in flight */
  loading?: boolean;
}

function verdictLabel(verdict: PreflightVerdict): { text: string; color: string; icon: string } {
  if (verdict === "ready") return { text: "Ready", color: "text-green-700 bg-green-50 border-green-200", icon: "✓" };
  if (verdict === "needs-clarification") return { text: "Needs clarification", color: "text-amber-700 bg-amber-50 border-amber-200", icon: "⚠" };
  if (verdict.startsWith("duplicate-of-#")) return { text: `Duplicate of ${verdict.replace("duplicate-of-", "")}`, color: "text-orange-700 bg-orange-50 border-orange-200", icon: "⊘" };
  if (verdict.startsWith("blocked-by-#")) return { text: `Blocked by ${verdict.replace("blocked-by-", "")}`, color: "text-red-700 bg-red-50 border-red-200", icon: "⛔" };
  return { text: verdict, color: "text-gray-700 bg-gray-50 border-gray-200", icon: "?" };
}

export function PreflightModal({
  result,
  issueId,
  projectId,
  issueTitle,
  issueDescription,
  onLaunchAnyway,
  onRetry,
  onCancel,
  loading,
}: PreflightModalProps) {
  const [editTitle, setEditTitle] = useState(issueTitle);
  const [editDescription, setEditDescription] = useState(issueDescription);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const badge = verdictLabel(result.verdict);
  const isBlocking = result.verdict !== "ready";

  async function handleSaveAndRetry() {
    if (saving) return;
    setSaving(true);
    try {
      await apiFetch(`/api/issues/${issueId}`, {
        method: "PATCH",
        body: JSON.stringify({ title: editTitle.trim(), description: editDescription }),
      });
      setIsEditing(false);
      onRetry(editTitle.trim(), editDescription);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-lg border border-gray-200 dark:border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Pre-flight Check</h2>
          <button
            onClick={onCancel}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1 rounded"
          >
            ✕
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Verdict badge */}
          <div className={`flex items-center gap-2 px-3 py-2 rounded border text-sm font-medium ${badge.color}`}>
            <span>{badge.icon}</span>
            <span>{badge.text}</span>
          </div>

          {/* Summary */}
          {result.summary && (
            <p className="text-sm text-gray-600 dark:text-gray-400">{result.summary}</p>
          )}

          {/* Questions */}
          {result.questions.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
                Questions to answer first
              </p>
              <ul className="space-y-1.5">
                {result.questions.map((q, i) => (
                  <li key={i} className="flex gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <span className="text-amber-500 font-bold mt-0.5">?</span>
                    <span>{q}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Inline editor */}
          {isEditing ? (
            <div className="space-y-2">
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block">Title</label>
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100"
              />
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block">Description</label>
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={8}
                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100 font-mono resize-y"
              />
            </div>
          ) : null}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-gray-200 dark:border-gray-700">
          <div className="flex gap-2">
            {isBlocking && !isEditing && (
              <button
                onClick={() => setIsEditing(true)}
                className="text-sm px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Edit ticket
              </button>
            )}
            {isEditing && (
              <>
                <button
                  onClick={handleSaveAndRetry}
                  disabled={saving || loading || !editTitle.trim()}
                  className="text-sm px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving || loading ? "Checking..." : "Save & re-check"}
                </button>
                <button
                  onClick={() => { setIsEditing(false); setEditTitle(issueTitle); setEditDescription(issueDescription); }}
                  className="text-sm px-3 py-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                >
                  Cancel edit
                </button>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="text-sm px-3 py-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              Cancel
            </button>
            {isBlocking && (
              <button
                onClick={onLaunchAnyway}
                disabled={loading}
                className="text-sm px-3 py-1.5 border border-amber-400 text-amber-700 dark:text-amber-400 rounded hover:bg-amber-50 dark:hover:bg-amber-900/20 disabled:opacity-50"
              >
                Launch anyway
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
