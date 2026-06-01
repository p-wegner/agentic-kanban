import { useState } from "react";
import type { WorkspacePreviewResult } from "../lib/workspace-preview.js";

interface WorkspacePreviewPanelProps {
  preview: WorkspacePreviewResult;
  branch?: string | null;
}

export function WorkspacePreviewPanel({ preview, branch }: WorkspacePreviewPanelProps) {
  const [frameKey, setFrameKey] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);

  if (!preview.ok) {
    return (
      <div
        className="border border-gray-200 dark:border-gray-700 rounded bg-gray-50 dark:bg-gray-900/50 p-4 text-sm"
        data-testid="workspace-preview-unavailable"
      >
        <div className="font-medium text-gray-700 dark:text-gray-200">Preview unavailable</div>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{preview.reason}</p>
      </div>
    );
  }

  const title = `Workspace preview${branch ? ` for ${branch}` : ""}`;

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded overflow-hidden bg-white dark:bg-gray-950" data-testid="workspace-preview-panel">
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-gray-700 dark:text-gray-200 truncate">{title}</div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{preview.url}</div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setLoadFailed(false);
              setFrameKey((key) => key + 1);
            }}
            className="p-1.5 rounded text-gray-500 hover:text-gray-800 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800"
            title="Refresh preview"
            aria-label="Refresh preview"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => window.open(preview.url, "_blank", "noopener,noreferrer")}
            className="p-1.5 rounded text-gray-500 hover:text-gray-800 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800"
            title="Open preview externally"
            aria-label="Open preview externally"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <path d="M15 3h6v6" />
              <path d="M10 14 21 3" />
            </svg>
          </button>
        </div>
      </div>

      {loadFailed && (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          The preview did not load. Start the workspace dev server, then refresh this panel.
        </div>
      )}

      <iframe
        key={frameKey}
        src={preview.url}
        title={title}
        className="block h-[520px] w-full bg-white"
        sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
        onError={() => setLoadFailed(true)}
      />
    </div>
  );
}
