import { useEffect, useState } from "react";
import { apiFetch, apiPost } from "../lib/api.js";
import { showToast } from "./Toast.js";

export interface TouchedFile {
  path: string;
  reason: string;
  confidence: "high" | "medium" | "low";
}

interface IssueTouchedFilesSectionProps {
  issueId: string;
  /**
   * Append the predicted file list to the issue description. Lives in the parent
   * because it mutates the edit-form draft (description + edit mode).
   */
  onAppendToDescription: (files: TouchedFile[]) => void;
}

/**
 * Touched-files prediction section. Self-contained (extracted from
 * IssueDetailPanel): owns the cached-prediction GET — moved out of the panel's
 * loadData mega-effect — plus the analyze/refresh POST and its busy state.
 */
export function IssueTouchedFilesSection({ issueId, onAppendToDescription }: IssueTouchedFilesSectionProps) {
  const [touchedFiles, setTouchedFiles] = useState<TouchedFile[] | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  // Best-effort: surface a cached prediction if one exists. Leave state null when
  // there's none so the section shows "Predict Files" rather than an empty list.
  useEffect(() => {
    setTouchedFiles(null);
    apiFetch<{ files: TouchedFile[]; cached: boolean }>(`/api/issues/${issueId}/touched-files`)
      .then((tf) => { if (tf.files.length > 0) setTouchedFiles(tf.files); })
      .catch(() => { /* No cached prediction yet — that's fine */ });
  }, [issueId]);

  async function analyze(refresh = false) {
    if (analyzing) return;
    setAnalyzing(true);
    try {
      const result = await apiPost<{ files: TouchedFile[]; cached: boolean }>(`/api/issues/${issueId}/analyze-touched-files`, { refresh });
      setTouchedFiles(result.files);
      showToast(result.cached ? "Showing cached prediction" : `Predicted ${result.files.length} file${result.files.length === 1 ? "" : "s"}`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Analysis failed", "error");
    } finally {
      setAnalyzing(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
          Touched Files
        </label>
        <div className="flex items-center gap-1">
          {touchedFiles && touchedFiles.length > 0 && (
            <button
              onClick={() => onAppendToDescription(touchedFiles)}
              className="text-[10px] text-gray-500 hover:text-gray-700 font-medium px-1.5 py-0.5 rounded border border-gray-200 hover:bg-gray-50"
              title="Append file list to description"
            >
              Append to desc
            </button>
          )}
          {touchedFiles && (
            <button
              onClick={() => analyze(true)}
              disabled={analyzing}
              className="text-[10px] text-blue-500 hover:text-blue-700 font-medium px-1.5 py-0.5 rounded border border-blue-200 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Refresh prediction"
            >
              ↺
            </button>
          )}
          <button
            onClick={() => analyze(false)}
            disabled={analyzing}
            className="text-[10px] text-blue-600 hover:text-blue-700 font-medium px-1.5 py-0.5 rounded border border-blue-200 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
            title="Predict files this issue will touch"
          >
            {analyzing && (
              <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
            )}
            {analyzing ? "Analyzing..." : "Predict Files"}
          </button>
        </div>
      </div>
      {touchedFiles && touchedFiles.length > 0 && (
        <div className="space-y-0.5">
          {touchedFiles.map((f, i) => (
            <div key={i} className="flex items-start gap-1.5 text-xs">
              <span className={`shrink-0 mt-0.5 px-1 py-px rounded text-[9px] font-medium ${
                f.confidence === "high" ? "bg-green-100 text-green-700" :
                f.confidence === "medium" ? "bg-yellow-100 text-yellow-700" :
                "bg-gray-100 text-gray-500"
              }`}>
                {f.confidence}
              </span>
              <span className="font-mono text-gray-700 dark:text-gray-300 break-all">{f.path}</span>
            </div>
          ))}
        </div>
      )}
      {touchedFiles && touchedFiles.length === 0 && (
        <p className="text-xs text-gray-400 dark:text-gray-500">No files predicted.</p>
      )}
    </div>
  );
}
