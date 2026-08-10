import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, apiPost } from "../lib/api.js";
import { subscribeSettingsInvalidated } from "../lib/settingsStore.js";
import { showToast } from "./Toast.js";
import { usePluginViewStore } from "../stores/pluginViewStore.js";
import {
  PluginLoopPane,
  PluginScriptPane,
  PluginSkillPane,
  type PluginLoop,
  type PluginOwner,
  type PluginScript,
  type PluginSkill,
} from "./PluginActionPanes.js";
import { PluginScaffoldPane, type ScaffoldForm } from "./PluginScaffoldPane.js";

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
  /** Project start policy (#293) — `manual` means the monitor never drives loops. */
  startPolicy?: { mode: string; autoStartUnblocked: boolean } | null;
};

const EMPTY_SURFACE: PluginSurface = { views: [], loops: [], scripts: [], skills: [], startPolicy: null };

type Selection =
  | { kind: "view"; key: string }
  | { kind: "loop"; key: string }
  | { kind: "script"; key: string }
  | { kind: "skill"; key: string }
  | { kind: "scaffold"; key: string };

const ownerKey = (o: PluginOwner, id: string) => `${o.pluginId}:${id}`;

/**
 * Last-request-wins latch for view starts (#251).
 *
 * A cold view spawn takes seconds, an already-running one resolves instantly, so
 * "click A, then click B" routinely resolves B FIRST. Without a guard, A's late
 * response still ran `setActiveUrl(A)` while the header showed B — the pane
 * rendered B's title around A's page — and A's `finally` cleared the `starting`
 * flag out from under B's in-flight launch. The latch records the key of the most
 * recent start and every continuation checks it, so a superseded response is
 * dropped whole (url, surface stamp and flag alike).
 */
export function createStartLatch() {
  let current: string | null = null;
  return {
    /** Claim the latch for a new start; supersedes anything in flight. */
    begin(key: string) { current = key; },
    /** False once another start has claimed the latch — the response is stale. */
    isCurrent(key: string) { return current === key; },
    /** Release, but only if still the current start (a stale finally is a no-op). */
    end(key: string) { if (current === key) current = null; },
  };
}

interface PluginViewsPanelProps {
  projectId: string;
  /** Which plugin's capabilities to show; null = resolve to the first available one. */
  pluginSlug: string | null;
}

/**
 * The board's per-plugin panel — every capability ONE enabled plugin offers,
 * started from one place. The plugin is picked in the toolbar's Plugins dropdown
 * tab (pluginViewStore); with nothing picked yet, the first plugin present in the
 * project's surface is auto-selected.
 *
 * It hosts four different KINDS of thing, and the distinction is the point rather
 * than an implementation detail: a **view** is a page the plugin serves (started
 * on demand, embedded in a sandboxed iframe), a **loop** is a converging analysis
 * the board drives by creating tickets, a **script** is a one-shot subprocess, and
 * a **skill** is judgment-requiring work launched as a ticket + workspace. The
 * rail groups by kind so "what can this plugin do here" is answerable at a glance;
 * the right pane belongs to whatever is selected.
 */
export function PluginViewsPanel({ projectId, pluginSlug }: PluginViewsPanelProps) {
  const [surface, setSurface] = useState<PluginSurface>(EMPTY_SURFACE);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const setStoreSelection = usePluginViewStore((s) => s.setSelection);
  const setStoreActiveProject = usePluginViewStore((s) => s.setActiveProject);
  const openMarketplace = usePluginViewStore((s) => s.openMarketplace);
  const loopFocus = usePluginViewStore((s) => s.loopFocus);
  const clearLoopFocus = usePluginViewStore((s) => s.clearLoopFocus);
  const startLatch = useRef(createStartLatch());

  const refetch = useCallback(async () => {
    try {
      const next = await apiFetch<PluginSurface>(`/api/projects/${projectId}/plugin-surface`);
      setSurface(next);
    } catch (err) {
      // Drop the previous project's surface. Keeping it leaves plugin rows from
      // project A clickable while `projectId` is already B, so every action POSTs
      // A's plugin row ids against B.
      setSurface(EMPTY_SURFACE);
      setSelection(null);
      setActiveUrl(null);
      showToast(err instanceof Error ? err.message : "Failed to load plugins", "error");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const startView = useCallback(async (view: PluginView) => {
    const key = ownerKey(view, view.id);
    const latch = startLatch.current;
    latch.begin(key);
    setActiveUrl(null);
    setStarting(true);
    try {
      // Start is idempotent server-side — returns the existing url when already running.
      const result = await apiPost<{ url: string; port: number; pid: number | null }>(
        `/api/plugins/${view.pluginId}/views/${encodeURIComponent(view.id)}/start`,
        { projectId },
      );
      // Another view was selected while this was in flight — its start owns the pane now.
      if (!latch.isCurrent(key)) return;
      setActiveUrl(result.url);
      // No frameKey bump here: the iframe is unmounted for the duration of the
      // start (the `starting` branch renders in its place), so it mounts fresh
      // on its own. Bumping it unconditionally also remounted the ALREADY-running
      // case, throwing away in-page state (graph zoom, form input) for nothing.
      // The key exists only to force a reload of an unchanged src — the Refresh button.
      setSurface((s) => ({
        ...s,
        views: s.views.map((v) =>
          ownerKey(v, v.id) === key ? { ...v, running: true, url: result.url, port: result.port } : v,
        ),
      }));
    } catch (err) {
      if (!latch.isCurrent(key)) return;
      showToast(err instanceof Error ? err.message : `Failed to start view "${view.label}"`, "error");
    } finally {
      // Only the current start owns the flag; a superseded one must not clear it
      // while its successor is still launching.
      if (latch.isCurrent(key)) {
        latch.end(key);
        setStarting(false);
      }
    }
  }, [projectId]);

  // #320 — Start Mode is a PREFERENCE, written from the Monitor popover, but the chip that
  // reports it ("Start mode is Manual — the monitor will not drive this loop") is rendered from
  // `surface.startPolicy`, which the server resolves per plugin-surface fetch. That fetch happens
  // once per project, so switching Start Mode left the chip asserting the old mode until a reload.
  // Refetching on a settings invalidation makes the chip converge without one.
  useEffect(() => subscribeSettingsInvalidated(() => { void refetch(); }), [refetch]);

  // A plugin pick belongs to the project it was made in — tell the store which
  // project is showing so a stale slug can't leak across a project switch.
  useEffect(() => {
    setStoreActiveProject(projectId);
  }, [projectId, setStoreActiveProject]);

  // Initial load per project. Selection is driven by the two effects below so a
  // plugin switch (same project, new slug) reuses the already-loaded surface.
  useEffect(() => {
    setLoading(true);
    setSelection(null);
    setActiveUrl(null);
    void refetch();
  }, [refetch]);

  // The slug-scoped slice of the surface this panel actually renders.
  const filtered = useMemo<PluginSurface>(() => {
    if (!pluginSlug) return surface;
    return {
      views: surface.views.filter((v) => v.pluginSlug === pluginSlug),
      loops: surface.loops.filter((l) => l.pluginSlug === pluginSlug),
      scripts: surface.scripts.filter((s) => s.pluginSlug === pluginSlug),
      skills: surface.skills.filter((s) => s.pluginSlug === pluginSlug),
      startPolicy: surface.startPolicy ?? null,
    };
  }, [surface, pluginSlug]);

  // The shown plugin's scaffold form state (#291): a "Setup" rail entry appears while
  // TODO markers remain — the same gate that blocks its scripts and loops.
  const shownPlugin = useMemo(
    () => [...filtered.views, ...filtered.loops, ...filtered.scripts, ...filtered.skills][0] ?? null,
    [filtered],
  );
  const [scaffold, setScaffold] = useState<ScaffoldForm | null>(null);
  const refetchScaffold = useCallback(async () => {
    if (!shownPlugin) { setScaffold(null); return; }
    try {
      setScaffold(await apiFetch<ScaffoldForm>(`/api/plugins/${shownPlugin.pluginId}/scaffold?projectId=${projectId}`));
    } catch {
      setScaffold(null); // 404 = the plugin declares no scaffold
    }
  }, [shownPlugin, projectId]);
  useEffect(() => { void refetchScaffold(); }, [refetchScaffold]);
  const scaffoldNeedsSetup = (scaffold?.exists && scaffold.fields.length > 0) ?? false;

  // No plugin picked yet (fresh navigation) → adopt the first plugin present.
  useEffect(() => {
    if (loading || pluginSlug) return;
    const first = [...surface.views, ...surface.loops, ...surface.scripts, ...surface.skills][0];
    if (first) setStoreSelection({ kind: "plugin", slug: first.pluginSlug });
  }, [loading, pluginSlug, surface, setStoreSelection]);

  // Whenever the SHOWN plugin changes, auto-select its first view (reusing the
  // server when already running), else its first loop — a plugin may offer no
  // views at all. Guarded per project+slug so refetches don't re-trigger it.
  const autoSelectedFor = useRef<string | null>(null);
  useEffect(() => {
    if (loading || !pluginSlug) return;
    const key = `${projectId}:${pluginSlug}`;
    if (autoSelectedFor.current === key) return;
    autoSelectedFor.current = key;
    setActiveUrl(null);
    if (filtered.views.length > 0) {
      const first = filtered.views[0];
      setSelection({ kind: "view", key: ownerKey(first, first.id) });
      void startView(first);
    } else if (filtered.loops.length > 0) {
      setSelection({ kind: "loop", key: ownerKey(filtered.loops[0], filtered.loops[0].name) });
    } else {
      setSelection(null);
    }
  }, [loading, pluginSlug, projectId, filtered, startView]);

  // Deep-link consumption (#300): a gate toast/notification/bell click asked for a
  // specific loop. Runs after the surface has loaded; one-shot per focus request.
  useEffect(() => {
    if (loading || !loopFocus) return;
    const target = surface.loops.find(
      (l) => l.pluginSlug === loopFocus.slug && l.name === loopFocus.loopName,
    );
    if (!target) return; // plugin not enabled here (or another project) — keep the request pending
    setSelection({ kind: "loop", key: ownerKey(target, target.name) });
    clearLoopFocus();
  }, [loading, loopFocus, surface.loops, clearLoopFocus]);

  // Latest selection, readable from an async continuation (state captured in a
  // closure is the selection as it was when the request went out).
  const selectionRef = useRef<Selection | null>(selection);
  useEffect(() => { selectionRef.current = selection; }, [selection]);

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
    // Capture the view being stopped: `selection` may have moved to another row by
    // the time the response lands, and keying off it then flips the WRONG row to
    // not-running while the stopped one still shows "live".
    const view = activeView;
    const stoppedKey = ownerKey(view, view.id);
    setStopping(true);
    try {
      await apiPost(`/api/plugins/${view.pluginId}/views/${encodeURIComponent(view.id)}/stop`, { projectId });
      // Same reason: only blank the pane if it is still showing the stopped view.
      if (selectionRef.current?.key === stoppedKey) setActiveUrl(null);
      setSurface((s) => ({
        ...s,
        views: s.views.map((v) => (ownerKey(v, v.id) === stoppedKey ? { ...v, running: false, url: undefined } : v)),
      }));
      showToast(`Stopped "${view.label}"`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to stop view", "error");
    } finally {
      setStopping(false);
    }
  }

  const surfaceEmpty = surface.views.length === 0 && surface.loops.length === 0
    && surface.scripts.length === 0 && surface.skills.length === 0;
  const filteredEmpty = filtered.views.length === 0 && filtered.loops.length === 0
    && filtered.scripts.length === 0 && filtered.skills.length === 0;
  const pluginName =
    [...filtered.views, ...filtered.loops, ...filtered.scripts, ...filtered.skills][0]?.pluginName
    ?? pluginSlug ?? "Plugins";

  if (loading) {
    return <div className="flex-1 p-6 text-sm text-gray-500 dark:text-gray-400">Loading plugins…</div>;
  }

  if (surfaceEmpty) {
    return (
      <div className="flex-1 flex items-center justify-center p-6" data-testid="plugin-views-empty-state">
        <div className="text-center max-w-md">
          <div className="text-3xl mb-2" aria-hidden="true">🧩</div>
          <div className="text-sm font-medium text-gray-700 dark:text-gray-200">No plugins enabled for this project</div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Install a plugin from the marketplace, then enable it for this project. Its views,
            analysis loops, scripts and skills each get their own entry in the Plugins tab.
          </p>
          <button
            onClick={() => openMarketplace()}
            className="mt-3 text-sm px-3 py-1.5 rounded bg-violet-600 text-white hover:bg-violet-700"
          >
            Open Marketplace
          </button>
        </div>
      </div>
    );
  }

  if (filteredEmpty) {
    // The plugin is enabled but contributes nothing visible here (e.g. only a
    // butler prompt fragment or a scaffold template).
    return (
      <div className="flex-1 flex items-center justify-center p-6" data-testid="plugin-views-plugin-empty-state">
        <div className="text-center max-w-md">
          <div className="text-3xl mb-2" aria-hidden="true">🧩</div>
          <div className="text-sm font-medium text-gray-700 dark:text-gray-200">
            {pluginName} adds no views, loops, scripts or skills
          </div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            This plugin only contributes background material (butler context, scaffold templates).
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
      {/* Capability rail (scoped to the selected plugin) */}
      <div className="w-56 shrink-0 border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 overflow-y-auto px-1.5 pb-3">
        <div
          className="px-2 pt-3 text-xs font-semibold text-gray-700 dark:text-gray-200 truncate"
          title={pluginName}
          data-testid="plugin-panel-title"
        >
          🧩 {pluginName}
        </div>
        {shownPlugin && scaffold?.exists && (
          <div className="space-y-0.5">
            <div className="px-2 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
              Setup
            </div>
            {railButton(
              "scaffold",
              scaffoldNeedsSetup ? "Setup required" : "Project profile",
              selection?.kind === "scaffold",
              () => setSelection({ kind: "scaffold", key: "scaffold" }),
              scaffoldNeedsSetup ? String(scaffold!.fields.length) : undefined,
            )}
          </div>
        )}
        {railGroup("Views", filtered.views, (view) =>
          railButton(
            ownerKey(view, view.id),
            view.label,
            selection?.kind === "view" && selection.key === ownerKey(view, view.id),
            () => selectView(view),
            view.running ? "live" : undefined,
          ))}
        {railGroup("Loops", filtered.loops, (loop) =>
          railButton(
            ownerKey(loop, loop.name),
            loop.label,
            selection?.kind === "loop" && selection.key === ownerKey(loop, loop.name),
            () => setSelection({ kind: "loop", key: ownerKey(loop, loop.name) }),
            // A pending gate outranks the ticket count (#301): it is the one state
            // that goes nowhere without the person looking at this rail.
            loop.gate && loop.openTickets === 0 ? "✋" : loop.openTickets > 0 ? String(loop.openTickets) : undefined,
          ))}
        {railGroup("Scripts", filtered.scripts, (script) =>
          railButton(
            ownerKey(script, script.name),
            script.label,
            selection?.kind === "script" && selection.key === ownerKey(script, script.name),
            () => setSelection({ kind: "script", key: ownerKey(script, script.name) }),
          ))}
        {railGroup("Skills", filtered.skills, (skill) =>
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
        {activeLoop && (
          <PluginLoopPane
            loop={activeLoop}
            projectId={projectId}
            onChanged={() => void refetch()}
            startPolicy={surface.startPolicy ?? null}
          />
        )}
        {activeScript && <PluginScriptPane script={activeScript} projectId={projectId} />}
        {activeSkill && <PluginSkillPane skill={activeSkill} projectId={projectId} />}
        {selection?.kind === "scaffold" && shownPlugin && (
          <PluginScaffoldPane
            pluginId={shownPlugin.pluginId}
            pluginName={shownPlugin.pluginName}
            projectId={projectId}
            onFilled={() => { void refetchScaffold(); void refetch(); }}
          />
        )}
        {!activeView && !activeLoop && !activeScript && !activeSkill && selection?.kind !== "scaffold" && (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">
            Select something on the left.
          </div>
        )}
      </div>
    </div>
  );
}
