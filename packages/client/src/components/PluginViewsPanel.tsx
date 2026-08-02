import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, apiPost } from "../lib/api.js";
import { showToast } from "./Toast.js";
import {
  PluginLoopPane,
  PluginScriptPane,
  PluginSkillPane,
  type PluginLoop,
  type PluginOwner,
  type PluginScript,
  type PluginSkill,
} from "./PluginActionPanes.js";

/** A plugin-served page, plus whether its server is currently up. */
type PluginView = PluginOwner & {
  id: string;
  label: string;
  kind: "iframe";
  description?: string | null;
  running: boolean;
  url?: string;
  port?: number;
  pid?: number | null;
  healthy?: boolean;
};

/** GET /api/projects/:projectId/plugin-surface — everything the enabled plugins offer. */
type PluginSurface = {
  views: PluginView[];
  loops: PluginLoop[];
  scripts: PluginScript[];
  skills: PluginSkill[];
};

const EMPTY_SURFACE: PluginSurface = { views: [], loops: [], scripts: [], skills: [] };

type Selection =
  | { kind: "view"; key: string }
  | { kind: "loop"; key: string }
  | { kind: "script"; key: string }
  | { kind: "skill"; key: string };

const ownerKey = (o: PluginOwner, id: string) => `${o.pluginId}:${id}`;

interface PluginViewsPanelProps {
  projectId: string;
}

/**
 * The board's Plugins panel — the single place every capability an enabled plugin
 * offers can be started from.
 *
 * It hosts four different KINDS of thing, and the distinction is the point rather
 * than an implementation detail: a **view** is a page the plugin serves (started
 * on demand, embedded in a sandboxed iframe), a **loop** is a converging analysis
 * the board drives by creating tickets, a **script** is a one-shot subprocess, and
 * a **skill** is judgment-requiring work launched as a ticket + workspace. The
 * rail groups by kind so "what can this plugin do here" is answerable at a glance;
 * the right pane belongs to whatever is selected.
 */
export function PluginViewsPanel({ projectId }: PluginViewsPanelProps) {
  const [surface, setSurface] = useState<PluginSurface>(EMPTY_SURFACE);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [frameKey, setFrameKey] = useState(0);

  const refetch = useCallback(async () => {
    try {
      const next = await apiFetch<PluginSurface>(`/api/projects/${projectId}/plugin-surface`);
      setSurface(next);
      return next;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to load plugins", "error");
      return EMPTY_SURFACE;
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const startView = useCallback(async (view: PluginView) => {
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
      setSurface((s) => ({
        ...s,
        views: s.views.map((v) =>
          ownerKey(v, v.id) === ownerKey(view, view.id) ? { ...v, running: true, url: result.url, port: result.port } : v,
        ),
      }));
    } catch (err) {
      showToast(err instanceof Error ? err.message : `Failed to start view "${view.label}"`, "error");
    } finally {
      setStarting(false);
    }
  }, [projectId]);

  // Initial load; auto-select the first view (reusing its url when already running),
  // else the first loop — a plugin may offer no views at all.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSelection(null);
    setActiveUrl(null);
    void refetch().then((next) => {
      if (cancelled) return;
      if (next.views.length > 0) {
        const first = next.views[0];
        setSelection({ kind: "view", key: ownerKey(first, first.id) });
        void startView(first);
      } else if (next.loops.length > 0) {
        setSelection({ kind: "loop", key: ownerKey(next.loops[0], next.loops[0].name) });
      }
    });
    return () => { cancelled = true; };
  }, [refetch, startView]);

  const activeView = useMemo(
    () => (selection?.kind === "view" ? surface.views.find((v) => ownerKey(v, v.id) === selection.key) ?? null : null),
    [selection, surface.views],
  );
  const activeLoop = useMemo(
    () => (selection?.kind === "loop" ? surface.loops.find((l) => ownerKey(l, l.name) === selection.key) ?? null : null),
    [selection, surface.loops],
  );
  const activeScript = useMemo(
    () => (selection?.kind === "script" ? surface.scripts.find((s) => ownerKey(s, s.name) === selection.key) ?? null : null),
    [selection, surface.scripts],
  );
  const activeSkill = useMemo(
    () => (selection?.kind === "skill" ? surface.skills.find((s) => ownerKey(s, s.name) === selection.key) ?? null : null),
    [selection, surface.skills],
  );

  function selectView(view: PluginView) {
    setSelection({ kind: "view", key: ownerKey(view, view.id) });
    void startView(view);
  }

  async function handleStop() {
    if (!activeView || stopping) return;
    setStopping(true);
    try {
      await apiPost(`/api/plugins/${activeView.pluginId}/views/${encodeURIComponent(activeView.id)}/stop`, { projectId });
      setActiveUrl(null);
      setSurface((s) => ({
        ...s,
        views: s.views.map((v) => (ownerKey(v, v.id) === selection?.key ? { ...v, running: false, url: undefined } : v)),
      }));
      showToast(`Stopped "${activeView.label}"`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to stop view", "error");
    } finally {
      setStopping(false);
    }
  }

  const isEmpty = surface.views.length === 0 && surface.loops.length === 0
    && surface.scripts.length === 0 && surface.skills.length === 0;

  if (loading) {
    return <div className="flex-1 p-6 text-sm text-gray-500 dark:text-gray-400">Loading plugins…</div>;
  }

  if (isEmpty) {
    return (
      <div className="flex-1 flex items-center justify-center p-6" data-testid="plugin-views-empty-state">
        <div className="text-center max-w-md">
          <div className="text-3xl mb-2" aria-hidden="true">🧩</div>
          <div className="text-sm font-medium text-gray-700 dark:text-gray-200">No plugins enabled for this project</div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Enable a plugin in Settings → Plugins. Its views, analysis loops, scripts and skills all appear here.
          </p>
        </div>
      </div>
    );
  }

  function railGroup<T>(title: string, items: T[], render: (item: T) => React.ReactNode) {
    if (items.length === 0) return null;
    return (
      <div className="space-y-0.5">
        <div className="px-2 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
          {title}
        </div>
        {items.map(render)}
      </div>
    );
  }

  function railButton(key: string, label: string, active: boolean, onClick: () => void, badge?: string) {
    return (
      <button
        key={key}
        onClick={onClick}
        className={`w-full text-left text-xs px-2 py-1.5 rounded flex items-center gap-1.5 ${
          active
            ? "bg-brand-600 text-white"
            : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
        }`}
        title={label}
      >
        <span className="truncate flex-1">{label}</span>
        {badge && (
          <span className={`text-[10px] px-1 rounded ${active ? "bg-brand-700 text-brand-100" : "bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300"}`}>
            {badge}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex" data-testid="plugin-views-panel">
      {/* Capability rail */}
      <div className="w-56 shrink-0 border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 overflow-y-auto px-1.5 pb-3">
        {railGroup("Views", surface.views, (view) =>
          railButton(
            ownerKey(view, view.id),
            view.label,
            selection?.kind === "view" && selection.key === ownerKey(view, view.id),
            () => selectView(view),
            view.running ? "live" : undefined,
          ))}
        {railGroup("Loops", surface.loops, (loop) =>
          railButton(
            ownerKey(loop, loop.name),
            loop.label,
            selection?.kind === "loop" && selection.key === ownerKey(loop, loop.name),
            () => setSelection({ kind: "loop", key: ownerKey(loop, loop.name) }),
            loop.openTickets > 0 ? String(loop.openTickets) : undefined,
          ))}
        {railGroup("Scripts", surface.scripts, (script) =>
          railButton(
            ownerKey(script, script.name),
            script.label,
            selection?.kind === "script" && selection.key === ownerKey(script, script.name),
            () => setSelection({ kind: "script", key: ownerKey(script, script.name) }),
          ))}
        {railGroup("Skills", surface.skills, (skill) =>
          railButton(
            ownerKey(skill, skill.name),
            skill.name,
            selection?.kind === "skill" && selection.key === ownerKey(skill, skill.name),
            () => setSelection({ kind: "skill", key: ownerKey(skill, skill.name) }),
          ))}
      </div>

      {/* Detail pane */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        {activeView && (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 py-1.5">
              <div className="text-xs text-gray-600 dark:text-gray-300 truncate">
                {activeView.pluginName} — {activeView.label}
              </div>
              {activeUrl && (
                <div className="flex items-center gap-1 shrink-0">
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
                </div>
              )}
            </div>
            {starting ? (
              <div className="flex-1 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">
                Starting {activeView.label}…
              </div>
            ) : activeUrl ? (
              <iframe
                key={frameKey}
                src={activeUrl}
                title={`${activeView.pluginName} — ${activeView.label}`}
                className="flex-1 w-full bg-white"
                sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                // A view is a whole tool inside a panel — a graph, a dashboard — and the panel is
                // the smallest part of the screen. Without this, requestFullscreen() REJECTS in
                // here (permissions policy, nothing to do with sandbox), so a view offering a
                // fullscreen control can only ever fall back to filling its own frame.
                allow="fullscreen"
              />
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <button
                  onClick={() => selectView(activeView)}
                  className="text-sm px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700"
                >
                  Start {activeView.label}
                </button>
              </div>
            )}
          </>
        )}
        {activeLoop && <PluginLoopPane loop={activeLoop} projectId={projectId} onChanged={() => void refetch()} />}
        {activeScript && <PluginScriptPane script={activeScript} projectId={projectId} />}
        {activeSkill && <PluginSkillPane skill={activeSkill} projectId={projectId} />}
        {!activeView && !activeLoop && !activeScript && !activeSkill && (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">
            Select something on the left.
          </div>
        )}
      </div>
    </div>
  );
}
