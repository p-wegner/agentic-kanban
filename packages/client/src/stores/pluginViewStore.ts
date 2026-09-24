// Which surface the "Plugins" view is showing: one specific plugin's capabilities,
// or the marketplace (install + browse). Lives in a store rather than view-mode
// state because two distant components drive it — the toolbar's Plugins dropdown
// tab picks, the plugin panel auto-resolves a default — and threading it through
// BoardPage props would touch every layer in between for one string.
import { create } from "zustand";

export type PluginViewSelection =
  | { kind: "plugin"; slug: string }
  | { kind: "marketplace" }
  /** A plugin-authored doc (manifest `docs[]`, GET /api/plugins/docs) shown in the panel. */
  | { kind: "guide"; pluginId: string; file: string; title: string };

interface PluginViewState {
  selection: PluginViewSelection | null;
  /** Bumped by "Install plugin…" so the marketplace focuses its install input. */
  installFocusNonce: number;
  /** Which project the current `selection` belongs to — see `setActiveProject`. */
  projectId: string | null;
  /**
   * One-shot deep-link request (#300): "show THIS loop when the Plugins view opens".
   * Set by gate toast/notification/bell clicks, consumed (and cleared) by
   * PluginViewsPanel once the loop is present in the loaded surface.
   */
  loopFocus: { slug: string; loopName: string; nonce: number } | null;
  /**
   * The iframe view id the panel is CURRENTLY showing for a `{kind:"plugin"}`
   * selection (#1227) — reported by PluginViewsPanel, read by the route hook
   * so a plugin's URL can name which of its views is open, the same way
   * `useViewTabStore.active` makes a container view's tab a URL dimension.
   * Null while nothing iframe-shaped is selected (a loop/script/skill/scaffold
   * pane, or no plugin picked yet).
   */
  activeViewId: string | null;
  /**
   * One-shot inbound request (#1227): "select THIS iframe view once its
   * plugin's surface has loaded" — set by the route hook from a pasted
   * `/plugin-views/<slug>/<view-id>` URL, consumed (and cleared) by
   * PluginViewsPanel. Unlike `loopFocus`, an unresolvable view id is expected
   * (a stale link, a typo) and falls back to the panel's normal default
   * landing pane rather than staying pending forever.
   */
  requestedViewId: { slug: string; viewId: string } | null;
  setSelection: (selection: PluginViewSelection | null) => void;
  openMarketplace: (opts?: { focusInstall?: boolean }) => void;
  focusLoop: (slug: string, loopName: string) => void;
  clearLoopFocus: () => void;
  setActiveViewId: (viewId: string | null) => void;
  requestViewId: (slug: string, viewId: string) => void;
  clearRequestedViewId: () => void;
  /**
   * Scope the selection to a project. A plugin pick is only meaningful for the
   * project it was made in: carried onto another project it names a plugin that
   * may not even be installed there, and the panel then renders its "‹slug› adds
   * no views, loops, scripts or skills" state about a plugin the project never
   * had. Switching projects therefore DROPS a plugin pick (the panel re-resolves
   * a default from the new project's surface). A marketplace pick survives — the
   * marketplace is not project-scoped.
   *
   * The FIRST announcement is not a switch (#925): on a cold page load the
   * toolbar menu writes its pick before the panel has mounted and announced the
   * project, so `projectId` is still null. That pick was made on the page that
   * is about to announce itself — dropping it here is what let the panel's
   * adopt-first-plugin default overwrite an explicit menu choice.
   */
  setActiveProject: (projectId: string | null) => void;
}

export const usePluginViewStore = create<PluginViewState>((set) => ({
  selection: null,
  installFocusNonce: 0,
  projectId: null,
  loopFocus: null,
  activeViewId: null,
  requestedViewId: null,
  setSelection: (selection) => set({ selection }),
  focusLoop: (slug, loopName) =>
    set((s) => ({
      selection: { kind: "plugin", slug },
      loopFocus: { slug, loopName, nonce: (s.loopFocus?.nonce ?? 0) + 1 },
    })),
  clearLoopFocus: () => set({ loopFocus: null }),
  setActiveProject: (projectId) =>
    set((s) => {
      if (s.projectId === projectId) return s;
      const adoptsPendingPick = s.projectId === null && projectId !== null;
      if (adoptsPendingPick) return { projectId };
      return { projectId, selection: s.selection?.kind === "plugin" ? null : s.selection };
    }),
  openMarketplace: (opts) =>
    set((s) => ({
      selection: { kind: "marketplace" },
      installFocusNonce: opts?.focusInstall ? s.installFocusNonce + 1 : s.installFocusNonce,
    })),
  setActiveViewId: (viewId) => set((s) => (s.activeViewId === viewId ? s : { activeViewId: viewId })),
  requestViewId: (slug, viewId) => set({ requestedViewId: { slug, viewId } }),
  clearRequestedViewId: () => set({ requestedViewId: null }),
}));
