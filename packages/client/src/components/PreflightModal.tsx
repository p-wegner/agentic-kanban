import { useState } from "react";
import { apiFetch } from "../lib/api.js";

export type PreflightVerdict = "ready" | "needs-clarification" | string;

export interface PreflightResult {
  verdict: PreflightVerdict;
  questions: string[];
  summary: string;
  duplicateOfNumber?: number;
  blockedByNumber?: number;
  /** True when the ticket looks like a non-trivial / multi-file feature. Combined with a
   *  direct workspace, this surfaces a warning recommending an isolated worktree. */
  looksComplex?: boolean;
  /** Markdown block of answered clarifications, returned when the re-check was run
   *  with clarifications. Caller prepends it to the launching agent's context. */
  clarificationsBlock?: string;
}

export interface PreflightClarification {
  question: string;
  answer: string;
}

interface PreflightModalProps {
  result: PreflightResult;
  issueId: string;
  projectId: string;
  issueTitle: string;
  issueDescription: string;
  /** Whether the pending launch targets a direct workspace (edits the main checkout in place).
   *  When true and the ticket looks complex, a non-blocking warning is shown. */
  isDirect?: boolean;
  onLaunchAnyway: () => void;
  onRetry: (updatedTitle: string, updatedDescription: string) => void;
  /** Submit answered clarifications: persists a comment, injects the Q&A into the
   *  launch context, and re-runs preflight. */
  onAnswerAndLaunch: (clarifications: PreflightClarification[]) => void;
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
  isDirect,
  onLaunchAnyway,
  onRetry,
  onAnswerAndLaunch,
  onCancel,
  loading,
}: PreflightModalProps) {
  const [editTitle, setEditTitle] = useState(issueTitle);
  const [editDescription, setEditDescription] = useState(issueDescription);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // One free-text answer per question (indexed parallel to result.questions).
  const [answers, setAnswers] = useState<string[]>(() => result.questions.map(() => ""));

  const badge = verdictLabel(result.verdict);
  const isBlocking = result.verdict !== "ready";
  const hasQuestions = result.questions.length > 0;
  const answeredCount = answers.filter((a) => a.trim()).length;
  // Advisory (non-blocking) warning: a complex ticket being run directly on the main checkout.
  const directRisk = Boolean(isDirect && result.looksComplex);
  // The "Launch anyway" affordance is shown whenever the modal needs an explicit decision —
  // either the verdict blocks, or there's a direct-workspace risk to acknowledge.
  const showLaunchAnyway = isBlocking || directRisk;

  async function handleSaveAndRetry() {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await apiFetch(`/api/issues/${issueId}`, {
        method: "PATCH",
        body: JSON.stringify({ title: editTitle.trim(), description: editDescription }),
      });
      setIsEditing(false);
      onRetry(editTitle.trim(), editDescription);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save ticket");
    } finally {
      setSaving(false);
    }
  }

  function handleAnswerAndLaunch() {
    const clarifications = result.questions
      .map((question, i) => ({ question, answer: answers[i]?.trim() ?? "" }))
      .filter((c) => c.answer.length > 0);
    if (clarifications.length === 0) return;
    onAnswerAndLaunch(clarifications);
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

          {/* Direct-workspace risk warning (non-blocking) */}
          {directRisk && (
            <div className="flex gap-2 px-3 py-2 rounded border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20 text-sm text-amber-800 dark:text-amber-300">
              <span className="font-bold mt-0.5">⚠</span>
              <div>
                <p className="font-medium">This looks like a complex feature for a direct workspace.</p>
                <p className="mt-1 text-amber-700 dark:text-amber-400">
                  Direct workspaces edit the main checkout in place (no isolated worktree), so a
                  large or destructive change can contaminate the main repo and block other work.
                  Consider unchecking “Work directly on main checkout” to use an isolated worktree instead.
                </p>
              </div>
            </div>
          )}

          {/* Questions + per-question answer fields */}
          {hasQuestions && !isEditing && (
            <div>
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
                Answer to clarify, then launch
              </p>
              <ul className="space-y-3">
                {result.questions.map((q, i) => (
                  <li key={i} className="space-y-1">
                    <div className="flex gap-2 text-sm text-gray-700 dark:text-gray-300">
                      <span className="text-amber-500 font-bold mt-0.5">?</span>
                      <span>{q}</span>
                    </div>
                    <textarea
                      value={answers[i] ?? ""}
                      onChange={(e) => setAnswers((prev) => prev.map((a, j) => (j === i ? e.target.value : a)))}
                      rows={2}
                      placeholder="Your answer…"
                      className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100 resize-y"
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Inline editor */}
          {isEditing ? (
            <div className="space-y-2">
              {saveError && (
                <p className="text-xs text-red-600 dark:text-red-400">{saveError}</p>
              )}
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
                onClick={() => { setIsEditing(true); setSaveError(null); }}
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
            {showLaunchAnyway && (
              <button
                onClick={onLaunchAnyway}
                disabled={loading}
                className="text-sm px-3 py-1.5 border border-amber-400 text-amber-700 dark:text-amber-400 rounded hover:bg-amber-50 dark:hover:bg-amber-900/20 disabled:opacity-50"
              >
                Launch anyway
              </button>
            )}
            {isBlocking && hasQuestions && !isEditing && (
              <button
                onClick={handleAnswerAndLaunch}
                disabled={loading || answeredCount === 0}
                title={answeredCount === 0 ? "Answer at least one question first" : "Save answers and re-check"}
                className="text-sm px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? "Checking..." : "Answer & launch"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
