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

/**
 * Who a rail entry is for (#456). Mirrors `PluginAudience` in the manifest contract; the
 * field is optional on the wire because an older server never sends it — absent means
 * `operator`, which is what every pre-#456 manifest gets.
 */
type Audience = "operator" | "developer";
type WithAudience = { audience?: Audience | null };

/** A plugin-served page, plus whether its server is currently up. */
type PluginView = PluginOwner & WithAudience & {
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

type RailScript = PluginScript & WithAudience;
type RailSkill = PluginSkill & WithAudience;

/**
 * Split a rail group into the workflow half and the diagnostics half (#456).
 *
 * The rail listed seven pm-pipeline entries at identical weight, five of which were
 * operator/developer debris (`Plugin selftest` validates the plugin's own fixtures;
 * `pm-step-runner` is the skill the LOOP launches, so pressing it by hand duplicates loop
 * work) — and the one entry that was the actual workflow sat in the middle of them. A
 * manifest can now mark an entry `audience: "developer"`; those collapse under a
 * "Diagnostics" disclosure at the bottom instead of competing with the job.
 *
 * Anything unmarked is `operator`, so a manifest that says nothing renders unchanged.
 */
export function splitByAudience<T extends WithAudience>(items: T[]): { operator: T[]; developer: T[] } {
  const operator: T[] = [];
  const developer: T[] = [];
  for (const item of items) (item.audience === "developer" ? developer : operator).push(item);
  return { operator, developer };
}

/** GET /api/projects/:projectId/plugin-surface — everything the enabled plugins offer. */
type PluginSurface = {
  views: PluginView[];
  loops: PluginLoop[];
  scripts: RailScript[];
  skills: RailSkill[];
  /**
   * Enabled plugins whose on-disk manifest is ahead of the one the board runs (#442).
   * The marketplace has warned about this since #295, but an operator drives loops from
   * HERE and never opens Settings — so a stale manifest ran silently.
   */
  drifted?: Array<{ pluginId: string; pluginSlug: string; pluginName: string }>;
  /** Project start policy (#293) — `manual` means the monitor never drives loops. */
  startPolicy?: { mode: string; autoStartUnblocked: boolean } | null;
};

const EMPTY_SURFACE: PluginSurface = { views: [], loops: [], scripts: [], skills: [], drifted: [], startPolicy: null };

type Selection =
  | { kind: "view"; key: string }
  | { kind: "loop"; key: string }
  | { kind: "script"; key: string }
  | { kind: "skill"; key: string }
  | { kind: "scaffold"; key: string };

const ownerKey = (o: PluginOwner, id: string) => `${o.pluginId}:${id}`;

/** Remembered rail visibility (#432) — an explicit choice outranks the width default. */
const RAIL_OPEN_STORAGE_KEY = "kanban.pluginRail.open";

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

  /**
   * Capability-rail visibility (#432). The rail was a hard `w-56` column with no way to
   * dismiss it: on a 390px phone it took 238px — 61% of the screen — leaving the detail
   * pane wrapping at 2-4 words per line, which makes answering a human gate on a phone
   * impractical. It is now collapsible on every size, and on mobile it is an OVERLAY
   * rather than a column, so opening it never costs the content any width.
   *
   * Initial state is width-derived (open on >=md, closed below) and an explicit user
   * choice is remembered. `matchMedia` is read lazily inside the initializer so this
   * still renders under SSR/jsdom where `window` may be absent.
   */
  const [railOpen, setRailOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(RAIL_OPEN_STORAGE_KEY);
      if (stored === "true") return true;
      if (stored === "false") return false;
    } catch { /* private mode / storage disabled — fall through to the width default */ }
    try {
      return window.matchMedia("(min-width: 768px)").matches;
    } catch {
      return true;
    }
  });

  /**
   * Persist the choice ONLY at desktop width (#437). Below md the rail is an overlay, so
   * closing it is dismissing a drawer — not a statement about how you want the pane laid out.
   * Persisting that leaked across form factors: dismissing the drawer on a phone left the rail
   * collapsed on the desktop the next time, where "collapsed" means something else entirely.
   */
  const toggleRail = useCallback((next: boolean) => {
    setRailOpen(next);
    try {
      if (window.matchMedia("(min-width: 768px)").matches) {
        localStorage.setItem(RAIL_OPEN_STORAGE_KEY, String(next));
      }
    } catch { /* non-fatal */ }
  }, []);

  /**
   * Picking something on a phone should reveal it, not leave the drawer covering it.
   * Desktop keeps the rail pinned — there the rail costs nothing, and closing it on
   * every click would be hostile.
   */
  const closeRailOnMobile = useCallback(() => {
    try {
      if (!window.matchMedia("(min-width: 768px)").matches) toggleRail(false);
    } catch { /* no matchMedia — leave it open */ }
  }, [toggleRail]);

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
      drifted: (surface.drifted ?? []).filter((d) => d.pluginSlug === pluginSlug),
      startPolicy: surface.startPolicy ?? null,
    };
  }, [surface, pluginSlug]);

  // Workflow vs. diagnostics split of each group (#456). Loops are always workflow — a loop
  // IS the job the panel exists for — so only views/scripts/skills carry an audience.
  const railViews = useMemo(() => splitByAudience(filtered.views), [filtered.views]);
  const railScripts = useMemo(() => splitByAudience(filtered.scripts), [filtered.scripts]);
  const railSkills = useMemo(() => splitByAudience(filtered.skills), [filtered.skills]);
  const operatorViews = railViews.operator;
  const diagnosticsCount =
    railViews.developer.length + railScripts.developer.length + railSkills.developer.length;
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  /** Never let the disclosure hide the row the pane is showing (deep link, refetch, reselect). */
  const selectionIsDiagnostic = useMemo(() => {
    if (!selection) return false;
    if (selection.kind === "view") return railViews.developer.some((v) => ownerKey(v, v.id) === selection.key);
    if (selection.kind === "script") return railScripts.developer.some((s) => ownerKey(s, s.name) === selection.key);
    if (selection.kind === "skill") return railSkills.developer.some((s) => ownerKey(s, s.name) === selection.key);
    return false;
  }, [selection, railViews.developer, railScripts.developer, railSkills.developer]);

  // The shown plugin's scaffold form state (#291): a "Setup" rail entry appears while
  // TODO markers remain — the same gate that blocks its scripts and loops.
  const shownPlugin = useMemo(
    () => [...filtered.views, ...filtered.loops, ...filtered.scripts, ...filtered.skills][0] ?? null,
    [filtered],
  );
  const [scaffold, setScaffold] = useState<ScaffoldForm | null>(null);
  const [scaffoldLoading, setScaffoldLoading] = useState(true);
  const refetchScaffold = useCallback(async () => {
    if (!shownPlugin) { setScaffold(null); setScaffoldLoading(false); return; }
    setScaffoldLoading(true);
    try {
      setScaffold(await apiFetch<ScaffoldForm>(`/api/plugins/${shownPlugin.pluginId}/scaffold?projectId=${projectId}`));
    } catch {
      setScaffold(null); // 404 = the plugin declares no scaffold
    } finally {
      setScaffoldLoading(false);
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
    // Wait for the scaffold probe before choosing a landing pane — otherwise a
    // setup-required plugin lands on its loop for the first render and only then
    // corrects itself, which is a worse flicker than a short wait.
    if (scaffold === null && scaffoldLoading) return;
    const key = `${projectId}:${pluginSlug}`;
    if (autoSelectedFor.current === key) return;
    autoSelectedFor.current = key;
    setActiveUrl(null);
    // Setup outranks everything: a plugin whose scaffold still has unresolved TODO
    // markers cannot run its loops OR its scripts — the server 409s every advance.
    // Landing on the loop pane offered "Start loop" as the primary action when the
    // only possible outcome was that refusal (observed on a fresh project, #427).
    if (scaffoldNeedsSetup) {
      setSelection({ kind: "scaffold", key: "scaffold" });
    } else if (operatorViews.length > 0) {
      // #456 — land on a WORKFLOW view. A diagnostics view is opt-in from the disclosure;
      // auto-starting its server (and its pane) on arrival would defeat the point.
      const first = operatorViews[0];
      setSelection({ kind: "view", key: ownerKey(first, first.id) });
      void startView(first);
    } else if (filtered.loops.length > 0) {
      setSelection({ kind: "loop", key: ownerKey(filtered.loops[0], filtered.loops[0].name) });
    } else {
      setSelection(null);
    }
  }, [loading, pluginSlug, projectId, filtered, operatorViews, startView, scaffoldNeedsSetup, scaffold, scaffoldLoading]);

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
        // Every rail entry dismisses the drawer on mobile (no-op on desktop): picking
        // something must REVEAL it, not leave the overlay sitting on top of it (#432).
        onClick={() => { onClick(); closeRailOnMobile(); }}
        // py-2 (not py-1.5) puts the row at ~34px; still under the 44px iOS guideline but
        // the rail is a dense list where full-size rows would push Skills off-screen. The
        // gate's own action buttons — the thing you actually tap on a phone — are sized
        // properly in GateCard.
        className={`w-full text-left text-xs px-2 py-2 md:py-1.5 rounded flex items-center gap-1.5 ${
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

  // One renderer per kind, so a workflow entry and its diagnostics twin are literally the
  // same row — the audience decides only WHERE it is rendered, never how it behaves.
  function renderViewButton(view: PluginView) {
    return railButton(
      ownerKey(view, view.id),
      view.label,
      selection?.kind === "view" && selection.key === ownerKey(view, view.id),
      () => selectView(view),
      view.running ? "live" : undefined,
    );
  }
  function renderScriptButton(script: RailScript) {
    return railButton(
      ownerKey(script, script.name),
      script.label,
      selection?.kind === "script" && selection.key === ownerKey(script, script.name),
      () => setSelection({ kind: "script", key: ownerKey(script, script.name) }),
    );
  }
  function renderSkillButton(skill: RailSkill) {
    return railButton(
      ownerKey(skill, skill.name),
      skill.name,
      selection?.kind === "skill" && selection.key === ownerKey(skill, skill.name),
      () => setSelection({ kind: "skill", key: ownerKey(skill, skill.name) }),
    );
  }

  return (
    <div className="flex-1 min-h-0 flex relative" data-testid="plugin-views-panel">
      {/* Mobile scrim (#432): tapping outside the drawer dismisses it. `md:hidden` because on
          desktop the rail is a real column and must not be dimmable/dismissable-by-backdrop. */}
      {railOpen && (
        <button
          type="button"
          className="md:hidden absolute inset-0 z-20 bg-black/40"
          onClick={() => toggleRail(false)}
          aria-label="Close plugin menu"
          data-testid="plugin-rail-scrim"
        />
      )}
      {/* Capability rail (scoped to the selected plugin).
          Mobile: an absolutely-positioned OVERLAY, so showing it costs the content no width.
          Desktop (md+): a static column, exactly as before. */}
      <div
        className={`${railOpen ? "flex flex-col" : "hidden"} absolute inset-y-0 left-0 z-30 w-64 shadow-xl md:static md:z-auto md:w-56 md:shadow-none shrink-0 border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 overflow-y-auto px-1.5 pb-3`}
        data-testid="plugin-rail"
      >
        <div className="flex items-center gap-1 px-2 pt-3">
          <div
            className="text-xs font-semibold text-gray-700 dark:text-gray-200 truncate flex-1"
            title={pluginName}
            data-testid="plugin-panel-title"
          >
            🧩 {pluginName}
          </div>
          <button
            type="button"
            onClick={() => toggleRail(false)}
            className="shrink-0 p-2.5 sm:p-1 -mr-1 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center rounded text-gray-400 hover:text-gray-700 hover:bg-gray-200 dark:hover:text-gray-100 dark:hover:bg-gray-800"
            title="Hide plugin menu"
            aria-label="Hide plugin menu"
            data-testid="plugin-rail-close"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
        </div>
        {/* #442: what the board RUNS is the cached manifest; edits on disk do nothing until
            the author presses Update in Settings. Saying so here — where loops are actually
            started — is the difference between a two-second fix and chasing a phantom bug. */}
        {(filtered.drifted ?? []).length > 0 && (
          <div
            className="mt-2 mx-1 text-[11px] px-2 py-1.5 rounded bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800"
            data-testid="plugin-surface-drift"
          >
            ⚠ This plugin&apos;s manifest changed on disk. The board still runs the old version —
            press <span className="font-semibold">Update</span> in Settings → Plugins to apply it.
          </div>
        )}
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
        {/* Loops first (#456): the loop is the workflow this panel exists to drive, and it
            used to sit in the MIDDLE of the rail with diagnostics above and below it. */}
        {railGroup("Loops", filtered.loops, (loop) =>
          railButton(
            ownerKey(loop, loop.name),
            loop.label,
            selection?.kind === "loop" && selection.key === ownerKey(loop, loop.name),
            () => setSelection({ kind: "loop", key: ownerKey(loop, loop.name) }),
            // A pending gate outranks the ticket count (#301): it is the one state
            // that goes nowhere without the person looking at this rail.
            // #413: a count made of nothing but STRANDED tickets reads as live work when it
            // is the opposite — mark it "⚠" so the rail does not vouch for a phantom round.
            loop.gate && loop.openTickets === 0
              ? "✋"
              : loop.openTickets > 0
                ? (loop.openTicketRefs?.length === loop.openTickets
                    && loop.openTicketRefs.every((r) => r.stranded)
                    ? "⚠"
                    : String(loop.openTickets))
                : undefined,
          ))}
        {railGroup("Views", railViews.operator, renderViewButton)}
        {railGroup("Scripts", railScripts.operator, renderScriptButton)}
        {railGroup("Skills", railSkills.operator, renderSkillButton)}
        {/* Diagnostics (#456): developer-audience entries, collapsed at the bottom. Still one
            click away — the disclosure opens itself whenever the selected entry lives inside
            it, so a deep link or a re-render never points at a hidden row. */}
        {diagnosticsCount > 0 && (
          <details
            className="mt-2"
            open={diagnosticsOpen || selectionIsDiagnostic}
            onToggle={(e) => setDiagnosticsOpen((e.currentTarget as HTMLDetailsElement).open)}
            data-testid="plugin-rail-diagnostics"
          >
            <summary className="cursor-pointer list-none px-2 py-2 md:py-1.5 rounded text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-1">
              <span className="flex-1">Diagnostics</span>
              <span className="text-[10px] font-normal normal-case text-gray-400 dark:text-gray-500">
                {diagnosticsCount}
              </span>
            </summary>
            <div className="space-y-0.5">
              {railViews.developer.map(renderViewButton)}
              {railScripts.developer.map(renderScriptButton)}
              {railSkills.developer.map(renderSkillButton)}
            </div>
          </details>
        )}
      </div>

      {/* Detail pane */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        {/* The only way back to the rail once it is hidden, so it is rendered whenever the
            rail is closed at ANY size — not `md:hidden`, or collapsing on desktop would be
            a one-way door. */}
        {!railOpen && (
          // A 57px band to hold one toggle was out of proportion on a phone — with the 75px
          // header that was 132px of chrome before any content, and it repeated the "Plugins"
          // the header already shows (#437). The BAND is now the tap target: full-width and
          // ~32px, which is a comfortable touch area horizontally without costing a whole
          // row's worth of height. The button inside carries no padding of its own.
          <div className="flex items-center border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
            <button
              type="button"
              onClick={() => toggleRail(true)}
              className="flex flex-1 items-center gap-1.5 text-xs px-2 py-2 sm:py-1 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
              title="Show plugin menu"
              aria-label="Show plugin menu"
              data-testid="plugin-rail-open"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M3 6h18M3 12h18M3 18h18" />
              </svg>
              <span className="truncate">🧩 {pluginName}</span>
            </button>
          </div>
        )}
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
            setupRequired={scaffoldNeedsSetup ? {
              pendingFields: scaffold!.fields.length,
              targetPath: scaffold!.targetPath,
              onOpenSetup: () => setSelection({ kind: "scaffold", key: "scaffold" }),
            } : null}
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
