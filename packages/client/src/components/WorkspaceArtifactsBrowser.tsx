import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";

interface ArtifactEntry {
  path: string;
  type: "image" | "text" | "trace" | "other";
  size: number;
  modified: string;
  ext: string;
}

interface WorkspaceArtifactsBrowserProps {
  workspaceId: string;
}

const TYPE_ICONS: Record<string, string> = {
  image: "🖼",
  text: "📄",
  trace: "🔍",
  other: "📎",
};

const TYPE_LABELS: Record<string, string> = {
  image: "Images",
  text: "Text Files",
  trace: "Traces",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function groupByType(artifacts: ArtifactEntry[]): Record<string, ArtifactEntry[]> {
  const groups: Record<string, ArtifactEntry[]> = {};
  for (const a of artifacts) {
    const key = a.type;
    (groups[key] ??= []).push(a);
  }
  return groups;
}

export function WorkspaceArtifactsBrowser({ workspaceId }: WorkspaceArtifactsBrowserProps) {
  const [artifacts, setArtifacts] = useState<ArtifactEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedText, setSelectedText] = useState<{ path: string; content: string } | null>(null);
  const [previewImage, setPreviewImage] = useState<{ path: string; url: string } | null>(null);
  const [textLoading, setTextLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<ArtifactEntry[]>(`/api/workspaces/${workspaceId}/artifacts`)
      .then((result) => {
        if (!cancelled) {
          setArtifacts(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load artifacts");
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const handleOpenText = useCallback(async (path: string) => {
    setTextLoading(true);
    setSelectedText(null);
    try {
      const result = await apiFetch<{ content: string; path: string }>(
        `/api/workspaces/${workspaceId}/artifacts-file?path=${encodeURIComponent(path)}`,
      );
      setSelectedText(result);
    } catch (err) {
      setSelectedText({
        path,
        content: `Error: ${err instanceof Error ? err.message : "Failed to read file"}`,
      });
    } finally {
      setTextLoading(false);
    }
  }, [workspaceId]);

  const handleOpenImage = useCallback((path: string) => {
    const url = `/api/workspaces/${workspaceId}/artifacts-file?path=${encodeURIComponent(path)}`;
    setPreviewImage({ path, url });
  }, [workspaceId]);

  if (loading) {
    return (
      <div className="border border-gray-200 dark:border-gray-700 rounded p-4 text-sm">
        <div className="text-gray-500 dark:text-gray-400 text-xs animate-pulse">Scanning artifacts...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-gray-200 dark:border-gray-700 rounded p-4 text-sm" data-testid="artifacts-error">
        <div className="font-medium text-red-600 dark:text-red-400">Failed to load artifacts</div>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{error}</p>
      </div>
    );
  }

  if (!artifacts || artifacts.length === 0) {
    return (
      <div className="border border-gray-200 dark:border-gray-700 rounded p-4 text-sm" data-testid="artifacts-empty">
        <div className="text-gray-500 dark:text-gray-400 text-center py-4">
          <div className="text-lg mb-1">📂</div>
          <div className="text-xs">No recognized artifacts found in this workspace.</div>
          <div className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">
            Screenshots, logs, and traces will appear here when generated.
          </div>
        </div>
      </div>
    );
  }

  const groups = groupByType(artifacts);

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded overflow-hidden" data-testid="artifacts-browser">
      {/* Image preview modal */}
      {previewImage && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center"
          onClick={() => setPreviewImage(null)}
          data-testid="artifacts-image-modal"
        >
          <div
            className="relative max-w-[90vw] max-h-[90vh] bg-white dark:bg-gray-900 rounded-lg shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
              <span className="text-xs font-mono text-gray-600 dark:text-gray-400 truncate">{previewImage.path}</span>
              <button
                onClick={() => setPreviewImage(null)}
                className="ml-2 text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100"
                aria-label="Close preview"
              >
                ✕
              </button>
            </div>
            <img
              src={previewImage.url}
              alt={previewImage.path}
              className="max-w-full max-h-[80vh] object-contain"
            />
          </div>
        </div>
      )}

      {/* Text viewer */}
      {selectedText && (
        <div className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-mono text-gray-600 dark:text-gray-400 truncate">{selectedText.path}</span>
            <button
              onClick={() => setSelectedText(null)}
              className="text-xs text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100"
            >
              ✕ Close
            </button>
          </div>
          <pre className="text-[11px] font-mono text-gray-800 dark:text-gray-200 bg-white dark:bg-gray-950 border-t border-gray-200 dark:border-gray-700 p-3 overflow-auto max-h-64 whitespace-pre-wrap break-all">
            {selectedText.content}
          </pre>
        </div>
      )}

      {/* Artifact groups */}
      {(["image", "text", "trace"] as const).map((type) => {
        const items = groups[type];
        if (!items || items.length === 0) return null;
        return (
          <div key={type}>
            <div className="px-3 py-1.5 bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700 text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              {TYPE_LABELS[type] ?? type} ({items.length})
            </div>
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {items.map((a) => (
                <li key={a.path}>
                  <button
                    onClick={() => type === "image" ? handleOpenImage(a.path) : handleOpenText(a.path)}
                    disabled={textLoading}
                    className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800/50 flex items-center gap-2 group disabled:opacity-50"
                    title={a.path}
                  >
                    <span className="text-sm shrink-0">{TYPE_ICONS[type] ?? TYPE_ICONS.other}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-mono text-gray-700 dark:text-gray-300 truncate group-hover:text-blue-700 dark:group-hover:text-blue-400">
                        {a.path}
                      </div>
                      <div className="text-[10px] text-gray-400 dark:text-gray-500">
                        {formatSize(a.size)} &middot; {formatRelativeTime(a.modified)}
                      </div>
                    </div>
                    <span className="text-[10px] text-gray-400 dark:text-gray-500 uppercase shrink-0">{a.ext}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
