import { useCallback, useEffect, useState } from "react";
import { apiFetch, apiPost } from "../lib/api.js";
import { showToast } from "./Toast.js";

/** One entry from GET /api/projects/:projectId/plugin-views (flat enabled-views list). */
type ProjectPluginView = {
  /** Plugin DB row id — the `:id` segment for the start/stop routes. */
  pluginId: string;
  pluginSlug: string;
  pluginName: string;
  id: string;
  label: string;
  kind: "iframe";
  running: boolean;
  url?: string;
  port?: number;
  pid?: number | null;
  healthy?: boolean;
};

function keyOf(view: Pick<ProjectPluginView, "pluginId" | "id">): string {
  return `${view.pluginId}:${view.id}`;
}

interface PluginViewsPanelProps {
  projectId: string;
}

/**
 * Plugin view host: lists the current project's enabled plugin views as a tab
 * strip, starts the selected view's server (idempotent server-side), and embeds
 * the returned url in a sandboxed iframe (same approach as WorkspacePreviewPanel).
 */
export function PluginViewsPanel({ projectId }: PluginViewsPanelProps) {
  const [views, setViews] = useState<ProjectPluginView[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [frameKey, setFrameKey] = useState(0);

  const refetch = useCallback(async () => {
    try {
      const rows = await apiFetch<ProjectPluginView[]>(`/api/projects/${projectId}/plugin-views`);
      setViews(rows);
      return rows;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to load plugin views", "error");
      return [];
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const selectView = useCallback(async (view: ProjectPluginView) => {
    const key = keyOf(view);
    setActiveKey(key);
    setActiveUrl(null);
    setStarting(true);
    try {
      // Start is idempotent server-side — returns the existing url when already running.
      const result = await apiPost<{ url: string; port: number; pid: number | null }>(
        `/api/plugins/${view.pluginId}/views/${encodeURIComponent(view.id)}/start`,
        { projectId },
      );
      setActiveUrl(result.url);
      setFrameKey((k) => k + 1);
      setViews((rows) => rows.map((v) => (keyOf(v) === key ? { ...v, running: true, url: result.url, port: result.port } : v)));
    } catch (err) {
      showToast(err instanceof Error ? err.message : `Failed to start view "${view.label}"`, "error");
    } finally {
      setStarting(false);
    }
  }, [projectId]);

  // Initial load; auto-select the first view (reusing its url when already running).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setActiveKey(null);
    setActiveUrl(null);
    void refetch().then((rows) => {
      if (cancelled || rows.length === 0) return;
      void selectView(rows[0]);
    });
    return () => { cancelled = true; };
  }, [refetch, selectView]);

  const activeView = views.find((v) => keyOf(v) === activeKey) ?? null;

  async function handleStop() {
    if (!activeView || stopping) return;
    setStopping(true);
    try {
      await apiPost(`/api/plugins/${activeView.pluginId}/views/${encodeURIComponent(activeView.id)}/stop`, { projectId });
      setActiveUrl(null);
      setViews((rows) => rows.map((v) => (keyOf(v) === activeKey ? { ...v, running: false, url: undefined } : v)));
      showToast(`Stopped "${activeView.label}"`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to stop view", "error");
    } finally {
      setStopping(false);
    }
  }

  if (loading) {
    return <div className="flex-1 p-6 text-sm text-gray-500 dark:text-gray-400">Loading plugin views…</div>;
  }

  if (views.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-6" data-testid="plugin-views-empty-state">
        <div className="text-center max-w-md">
          <div className="text-3xl mb-2" aria-hidden="true">🧩</div>
          <div className="text-sm font-medium text-gray-700 dark:text-gray-200">No plugin views for this project</div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Enable a plugin in Settings → Plugins. Views declared in an enabled plugin's manifest appear here as embedded panels.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="plugin-views-panel">
      {/* Tab strip + actions */}
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 py-1.5">
        <div className="flex items-center gap-1 overflow-x-auto min-w-0">
          {views.map((view) => {
            const key = keyOf(view);
            const active = key === activeKey;
            return (
              <button
                key={key}
                onClick={() => void selectView(view)}
                title={`${view.pluginName} — ${view.label}`}
                className={`text-xs px-2.5 py-1.5 rounded whitespace-nowrap ${
                  active
                    ? "bg-brand-600 text-white"
                    : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
              >
                {view.label}
                {views.some((v) => v.pluginId !== view.pluginId) && (
                  <span className={`ml-1 ${active ? "text-brand-200" : "text-gray-400 dark:text-gray-500"}`}>· {view.pluginSlug}</span>
                )}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {activeUrl && (
            <>
              <button
                type="button"
                onClick={() => setFrameKey((k) => k + 1)}
                className="p-1.5 rounded text-gray-500 hover:text-gray-800 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800"
                title="Refresh view"
                aria-label="Refresh view"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <path d="M21 3v6h-6" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => window.open(activeUrl, "_blank", "noopener,noreferrer")}
                className="p-1.5 rounded text-gray-500 hover:text-gray-800 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800"
                title="Open in new tab"
                aria-label="Open in new tab"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <path d="M15 3h6v6" />
                  <path d="M10 14 21 3" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => void handleStop()}
                disabled={stopping}
                className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
                title="Stop the view's server process"
              >
                {stopping ? "Stopping…" : "Stop"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* View body */}
      {starting ? (
        <div className="flex-1 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">
          Starting {activeView?.label ?? "view"}…
        </div>
      ) : activeUrl && activeView ? (
        <iframe
          key={frameKey}
          src={activeUrl}
          title={`${activeView.pluginName} — ${activeView.label}`}
          className="flex-1 w-full bg-white"
          sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">
          {activeView ? (
            <button
              onClick={() => void selectView(activeView)}
              className="text-sm px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700"
            >
              Start {activeView.label}
            </button>
          ) : (
            "Select a view above."
          )}
        </div>
      )}
    </div>
  );
}
