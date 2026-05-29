import React, { useState } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";

interface ChildProposal {
  tempId: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "urgent";
}

interface DependencyProposal {
  fromTempId: string;
  toTempId: string;
  type: string;
}

interface DecomposeProposal {
  children: ChildProposal[];
  dependencies: DependencyProposal[];
  alreadyDecomposed: boolean;
}

interface EpicDecomposerModalProps {
  issue: IssueWithStatus;
  onClose: () => void;
  onConfirmed: () => void;
}

export function EpicDecomposerModal({ issue, onClose, onConfirmed }: EpicDecomposerModalProps) {
  const [stage, setStage] = useState<"idle" | "loading" | "preview" | "confirming">("idle");
  const [proposal, setProposal] = useState<DecomposeProposal | null>(null);
  const [children, setChildren] = useState<ChildProposal[]>([]);
  const [dependencies, setDependencies] = useState<DependencyProposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  async function fetchProposal() {
    setStage("loading");
    setError(null);
    try {
      const result = await apiFetch<DecomposeProposal>(`/api/issues/${issue.id}/decompose`, {
        method: "POST",
        body: JSON.stringify({ projectId: issue.projectId }),
      });
      setProposal(result);
      setChildren(result.children);
      setDependencies(result.dependencies);
      setStage("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate decomposition");
      setStage("idle");
    }
  }

  async function handleRegenerate() {
    if (regenerating) return;
    setRegenerating(true);
    setError(null);
    try {
      const result = await apiFetch<DecomposeProposal>(`/api/issues/${issue.id}/decompose`, {
        method: "POST",
        body: JSON.stringify({ projectId: issue.projectId }),
      });
      setProposal(result);
      setChildren(result.children);
      setDependencies(result.dependencies);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to regenerate decomposition");
    } finally {
      setRegenerating(false);
    }
  }

  async function handleConfirm() {
    if (children.length === 0) return;
    setStage("confirming");
    try {
      await apiFetch(`/api/issues/${issue.id}/decompose/confirm`, {
        method: "POST",
        body: JSON.stringify({
          projectId: issue.projectId,
          children: children.filter(c => c.title.trim()),
          dependencies,
        }),
      });
      showToast(`Created ${children.length} child tickets`, "success");
      onConfirmed();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm decomposition");
      setStage("preview");
    }
  }

  function handleRemoveChild(tempId: string) {
    setChildren(prev => prev.filter(c => c.tempId !== tempId));
    setDependencies(prev => prev.filter(d => d.fromTempId !== tempId && d.toTempId !== tempId));
  }

  function handleTitleChange(tempId: string, newTitle: string) {
    setChildren(prev => prev.map(c => c.tempId === tempId ? { ...c, title: newTitle } : c));
  }

  const tempIdToTitle = new Map(children.map(c => [c.tempId, c.title]));
  const validDeps = dependencies.filter(
    d => tempIdToTitle.has(d.fromTempId) && tempIdToTitle.has(d.toTempId),
  );

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-60" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(640px,96vw)] max-h-[90vh] bg-white dark:bg-gray-900 rounded-xl shadow-2xl z-70 flex flex-col border border-gray-200 dark:border-gray-700 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h8m-8 4h8" />
              </svg>
              Decompose Epic
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate max-w-md">
              #{issue.issueNumber} {issue.title}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {stage === "idle" && (
            <div className="text-center space-y-4 py-4">
              {proposal?.alreadyDecomposed && (
                <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3 text-sm text-amber-800 text-left">
                  <p className="font-medium">⚠ Already decomposed</p>
                  <p className="mt-1 text-xs">This epic already has child tickets. Regenerating will create additional children.</p>
                </div>
              )}
              <p className="text-sm text-gray-600 dark:text-gray-400">
                AI will analyze this epic and propose a set of focused child tickets with dependency ordering.
              </p>
              <button
                onClick={fetchProposal}
                className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l1.5 3.5L10 8l-3.5 1.5L5 13l-1.5-3.5L0 8l3.5-1.5L5 3zM19 11l1 2.5L22.5 14l-2.5 1L19 17.5l-1-2.5L15.5 14l2.5-1L19 11z" />
                </svg>
                Generate Decomposition
              </button>
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          )}

          {stage === "loading" && (
            <div className="text-center py-10 space-y-3">
              <svg className="animate-spin h-8 w-8 text-purple-500 mx-auto" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
              <p className="text-sm text-gray-500 dark:text-gray-400">AI is analyzing your epic…</p>
            </div>
          )}

          {(stage === "preview" || stage === "confirming") && (
            <>
              {proposal?.alreadyDecomposed && (
                <div className="bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-xs text-amber-800">
                  ⚠ This epic was previously decomposed. These will be additional children.
                </div>
              )}

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-md px-3 py-2 text-xs text-red-700">
                  {error}
                </div>
              )}

              {/* Children list */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">
                    Child Tickets ({children.length})
                  </h3>
                  <button
                    onClick={handleRegenerate}
                    disabled={regenerating || stage === "confirming"}
                    className="text-xs text-purple-600 hover:text-purple-800 disabled:opacity-50 flex items-center gap-1"
                    title="Regenerate proposal"
                  >
                    {regenerating ? (
                      <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    )}
                    Regenerate
                  </button>
                </div>
                <div className="space-y-2">
                  {children.map((child, idx) => (
                    <div
                      key={child.tempId}
                      className="flex items-start gap-2 p-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 group"
                    >
                      <span className="text-xs font-mono text-gray-400 dark:text-gray-500 shrink-0 mt-1 w-5 text-right">
                        {idx + 1}.
                      </span>
                      <div className="flex-1 min-w-0">
                        <input
                          type="text"
                          value={child.title}
                          onChange={(e) => handleTitleChange(child.tempId, e.target.value)}
                          disabled={stage === "confirming"}
                          className="w-full text-sm font-medium text-gray-900 dark:text-gray-100 bg-transparent border-0 border-b border-transparent hover:border-gray-300 dark:hover:border-gray-600 focus:border-blue-500 focus:outline-none px-0 py-0 disabled:cursor-default"
                          placeholder="Child ticket title…"
                        />
                        {child.description && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">
                            {child.description}
                          </p>
                        )}
                      </div>
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${
                        child.priority === "urgent" ? "bg-red-100 text-red-700" :
                        child.priority === "high" ? "bg-orange-100 text-orange-700" :
                        child.priority === "low" ? "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400" :
                        "bg-blue-100 text-blue-700"
                      }`}>
                        {child.priority}
                      </span>
                      <button
                        onClick={() => handleRemoveChild(child.tempId)}
                        disabled={stage === "confirming"}
                        className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 disabled:hidden transition-opacity shrink-0"
                        title="Remove this child ticket"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Dependencies */}
              {validDeps.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">
                    Dependencies ({validDeps.length})
                  </h3>
                  <div className="space-y-1">
                    {validDeps.map((dep, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                        <span className="truncate max-w-[180px] font-medium text-gray-800 dark:text-gray-200">
                          {tempIdToTitle.get(dep.fromTempId)}
                        </span>
                        <span className="text-gray-400 shrink-0">→ {dep.type.replace("_", " ")}</span>
                        <span className="truncate max-w-[180px] font-medium text-gray-800 dark:text-gray-200">
                          {tempIdToTitle.get(dep.toTempId)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-xs text-gray-500 dark:text-gray-400">
                Confirming will create {children.filter(c => c.title.trim()).length} child tickets in Backlog, add the <span className="font-medium text-purple-600">epic</span> tag to this issue, and prepend a subtask checklist to the description.
              </p>
            </>
          )}
        </div>

        {/* Footer */}
        {(stage === "preview" || stage === "confirming") && (
          <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              disabled={stage === "confirming"}
              className="text-sm text-gray-500 dark:text-gray-400 px-4 py-1.5 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={stage === "confirming" || children.filter(c => c.title.trim()).length === 0}
              className="flex items-center gap-1.5 text-sm font-medium px-4 py-1.5 rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 transition-colors"
            >
              {stage === "confirming" ? (
                <>
                  <svg className="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                  </svg>
                  Creating…
                </>
              ) : (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Create {children.filter(c => c.title.trim()).length} Tickets
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
