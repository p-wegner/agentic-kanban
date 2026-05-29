import { useState, useCallback } from "react";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";

interface CodemodFileDiff {
  filePath: string;
  relativePath: string;
  diff: string;
  original: string;
  modified: string;
}

interface CodemodPreviewResponse {
  script: string;
  description: string;
  files: CodemodFileDiff[];
  totalTsFiles: number;
  limitReached: boolean;
}

interface CodemodPanelProps {
  onClose: () => void;
  activeProjectId?: string | null;
}

function DiffFileView({ file }: { file: CodemodFileDiff }) {
  const [expanded, setExpanded] = useState(true);

  const lines = file.diff.split("\n");
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-750"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-xs text-gray-400">{expanded ? "▼" : "▶"}</span>
        <span className="text-xs font-mono font-semibold text-gray-700 dark:text-gray-300 flex-1 truncate">
          {file.relativePath}
        </span>
        <span className="text-xs text-green-600 dark:text-green-400">
          +{lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length}
        </span>
        <span className="text-xs text-red-600 dark:text-red-400 ml-1">
          -{lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length}
        </span>
      </div>
      {expanded && (
        <div className="overflow-x-auto">
          <pre className="text-[11px] font-mono leading-relaxed">
            {lines.map((line, i) => {
              let bg = "";
              let color = "text-gray-600 dark:text-gray-400";
              if (line.startsWith("@@")) {
                bg = "bg-blue-50 dark:bg-blue-950";
                color = "text-blue-600 dark:text-blue-400";
              } else if (line.startsWith("+") && !line.startsWith("+++")) {
                bg = "bg-green-50 dark:bg-green-950";
                color = "text-green-800 dark:text-green-300";
              } else if (line.startsWith("-") && !line.startsWith("---")) {
                bg = "bg-red-50 dark:bg-red-950";
                color = "text-red-800 dark:text-red-300";
              } else if (line.startsWith("---") || line.startsWith("+++")) {
                bg = "bg-gray-100 dark:bg-gray-800";
                color = "text-gray-500 dark:text-gray-500";
              }
              return (
                <div key={i} className={`px-3 py-0 ${bg} ${color}`}>
                  {line || " "}
                </div>
              );
            })}
          </pre>
        </div>
      )}
    </div>
  );
}

export function CodemodPanel({ onClose, activeProjectId }: CodemodPanelProps) {
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<CodemodPreviewResponse | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [applyingChanges, setApplyingChanges] = useState(false);
  const [savingCodemod, setSavingCodemod] = useState(false);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [overrideLimit, setOverrideLimit] = useState(false);
  const [limitWarning, setLimitWarning] = useState<string | null>(null);
  const [expandScript, setExpandScript] = useState(false);

  const handlePreview = useCallback(async (opts?: { override?: boolean; script?: string }) => {
    if (!description.trim()) {
      showToast("Please describe the refactor you want to apply.", "error");
      return;
    }
    if (!activeProjectId) {
      showToast("No active project selected.", "error");
      return;
    }

    setLoading(true);
    setLimitWarning(null);
    setPreview(null);
    try {
      const result = await apiFetch<CodemodPreviewResponse>("/api/codemods/preview", {
        method: "POST",
        body: JSON.stringify({
          description: description.trim(),
          projectId: activeProjectId,
          overrideLimit: opts?.override ?? overrideLimit,
          script: opts?.script,
        }),
      });
      setPreview(result);
      // Select all files by default
      setSelectedFiles(new Set(result.files.map((f) => f.filePath)));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("more than 100 files") || msg.includes("overrideLimit")) {
        setLimitWarning(msg);
      } else {
        showToast(msg, "error");
      }
    } finally {
      setLoading(false);
    }
  }, [description, activeProjectId, overrideLimit]);

  const toggleFile = (filePath: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const toggleAll = () => {
    if (!preview) return;
    if (selectedFiles.size === preview.files.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(preview.files.map((f) => f.filePath)));
    }
  };

  const handleApply = useCallback(async () => {
    if (!preview || selectedFiles.size === 0) return;
    setApplyingChanges(true);
    try {
      const result = await apiFetch<{ applied: string[]; skipped: string[] }>("/api/codemods/apply", {
        method: "POST",
        body: JSON.stringify({
          projectId: activeProjectId,
          changes: preview.files.map((f) => ({ filePath: f.filePath, modified: f.modified })),
          selectedFiles: Array.from(selectedFiles),
        }),
      });
      showToast(`Applied ${result.applied.length} file(s). Skipped ${result.skipped.length}.`, "success");
      setPreview(null);
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "Apply failed", "error");
    } finally {
      setApplyingChanges(false);
    }
  }, [preview, selectedFiles]);

  const handleSave = useCallback(async () => {
    if (!preview || !saveName.trim()) return;
    setSavingCodemod(true);
    try {
      await apiFetch("/api/codemods", {
        method: "POST",
        body: JSON.stringify({
          name: saveName.trim(),
          description: description.trim(),
          script: preview.script,
          projectId: activeProjectId ?? null,
        }),
      });
      showToast(`Codemod "${saveName}" saved.`, "success");
      setShowSaveForm(false);
      setSaveName("");
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "Save failed", "error");
    } finally {
      setSavingCodemod(false);
    }
  }, [preview, saveName, description, activeProjectId]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 overflow-y-auto">
      <div className="relative bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-4xl mx-4 my-8 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Codemod Factory</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Describe a refactor in plain English — AI generates a ts-morph codemod with live preview
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
          {/* Description input */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Describe the refactor
            </label>
            <textarea
              className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              rows={3}
              placeholder='e.g. "Rename all occurrences of UserService class to AccountService" or "Add async keyword to every method that returns Promise<T>"'
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={loading}
            />
          </div>

          {/* Limit warning */}
          {limitWarning && (
            <div className="bg-yellow-50 dark:bg-yellow-950 border border-yellow-300 dark:border-yellow-700 rounded-md p-3">
              <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-2">{limitWarning}</p>
              <button
                onClick={() => { setOverrideLimit(true); handlePreview({ override: true }); }}
                className="text-xs px-3 py-1 bg-yellow-500 hover:bg-yellow-600 text-white rounded"
              >
                Yes, I know — run codemod on all files
              </button>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => handlePreview()}
              disabled={loading || !description.trim() || !activeProjectId}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-md font-medium"
            >
              {loading ? "Generating…" : preview ? "Re-generate" : "Generate Preview"}
            </button>
            {!activeProjectId && (
              <span className="text-xs text-red-500">No active project</span>
            )}
          </div>

          {/* Loading spinner */}
          {loading && (
            <div className="text-center py-8 text-sm text-gray-500 dark:text-gray-400">
              <div className="inline-block animate-spin rounded-full h-5 w-5 border-2 border-blue-500 border-t-transparent mr-2" />
              Analyzing code and generating codemod…
            </div>
          )}

          {/* Preview results */}
          {preview && !loading && (
            <div className="space-y-4">
              {/* Stats bar */}
              <div className="flex items-center gap-3 text-sm flex-wrap">
                <span className="text-gray-600 dark:text-gray-400">
                  <strong>{preview.files.length}</strong> file{preview.files.length !== 1 ? "s" : ""} would change
                  {" "}of {preview.totalTsFiles} total TypeScript files
                </span>
                {preview.limitReached && (
                  <span className="text-xs px-2 py-0.5 bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200 rounded">
                    limit override active
                  </span>
                )}
                {preview.files.length === 0 && (
                  <span className="text-gray-500 dark:text-gray-400 italic">No changes detected</span>
                )}
              </div>

              {/* Generated script toggle */}
              <div>
                <button
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                  onClick={() => setExpandScript((v) => !v)}
                >
                  {expandScript ? "▼ Hide" : "▶ Show"} generated ts-morph script
                </button>
                {expandScript && (
                  <pre className="mt-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-3 text-[11px] font-mono overflow-x-auto text-gray-800 dark:text-gray-200 whitespace-pre-wrap">
                    {preview.script}
                  </pre>
                )}
              </div>

              {/* File list with diffs */}
              {preview.files.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Changed files</span>
                    <button
                      onClick={toggleAll}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      {selectedFiles.size === preview.files.length ? "Deselect all" : "Select all"}
                    </button>
                  </div>

                  {preview.files.map((file) => (
                    <div key={file.filePath} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        id={`file-${file.filePath}`}
                        checked={selectedFiles.has(file.filePath)}
                        onChange={() => toggleFile(file.filePath)}
                        className="mt-2.5 h-4 w-4 accent-blue-600 flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <DiffFileView file={file} />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Apply / Save section */}
              {preview.files.length > 0 && (
                <div className="flex items-center gap-3 flex-wrap pt-2 border-t border-gray-200 dark:border-gray-700">
                  <button
                    onClick={handleApply}
                    disabled={applyingChanges || selectedFiles.size === 0}
                    className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-md font-medium"
                  >
                    {applyingChanges ? "Applying…" : `Apply ${selectedFiles.size} file${selectedFiles.size !== 1 ? "s" : ""}`}
                  </button>

                  {!showSaveForm ? (
                    <button
                      onClick={() => { setShowSaveForm(true); setSaveName(description.slice(0, 40)); }}
                      className="px-3 py-2 text-sm text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      Save codemod for reuse
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={saveName}
                        onChange={(e) => setSaveName(e.target.value)}
                        placeholder="Codemod name"
                        className="text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 w-48"
                        onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") setShowSaveForm(false); }}
                      />
                      <button
                        onClick={handleSave}
                        disabled={savingCodemod || !saveName.trim()}
                        className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded"
                      >
                        {savingCodemod ? "Saving…" : "Save"}
                      </button>
                      <button
                        onClick={() => setShowSaveForm(false)}
                        className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
