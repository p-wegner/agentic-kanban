// Cross-component "open this container view at tab X" requests (#234/#235).
//
// Tabbed container views (Analytics, the two event feeds) own their active-tab
// state locally, but two distant producers need to preselect a tab:
//   - command-palette actions ("Analytics: Burndown") registered in
//     useBoardKeyboardShortcuts, and
//   - legacy deep-link routes (/burndown, /digest, …) resolved in
//     useBoardPageRoute.
// Threading that through BoardPage props would touch every layer for one
// string, so — like pluginViewStore — it lives in a tiny store. A request is
// one-shot: the container consumes it on (re)mount or change and clears it.
import { create } from "zustand";

interface ViewTabState {
  /** Pending tab requests keyed by container view id (e.g. "analytics"). */
  requested: Partial<Record<string, string>>;
  /**
   * The tab each MOUNTED container is currently showing (#446). Reported by
   * useViewTab and read by useBoardPageRoute, which is what makes the tab a URL
   * dimension: the address bar is driven off state, exactly like the open issue.
   */
  active: Partial<Record<string, string>>;
  request: (viewId: string, tabId: string) => void;
  clear: (viewId: string) => void;
  setActive: (viewId: string, tabId: string) => void;
  clearActive: (viewId: string) => void;
}

export const useViewTabStore = create<ViewTabState>((set) => ({
  requested: {},
  active: {},
  request: (viewId, tabId) =>
    set((s) => ({ requested: { ...s.requested, [viewId]: tabId } })),
  clear: (viewId) =>
    set((s) => {
      if (!(viewId in s.requested)) return s;
      const next = { ...s.requested };
      delete next[viewId];
      return { requested: next };
    }),
  setActive: (viewId, tabId) =>
    set((s) => (s.active[viewId] === tabId ? s : { active: { ...s.active, [viewId]: tabId } })),
  clearActive: (viewId) =>
    set((s) => {
      if (!(viewId in s.active)) return s;
      const next = { ...s.active };
      delete next[viewId];
      return { active: next };
    }),
}));

/** Imperative facade for non-React callers (palette handlers, route resolution). */
export const viewTabActions = {
  request: (viewId: string, tabId: string) => useViewTabStore.getState().request(viewId, tabId),
  clear: (viewId: string) => useViewTabStore.getState().clear(viewId),
  setActive: (viewId: string, tabId: string) => useViewTabStore.getState().setActive(viewId, tabId),
  clearActive: (viewId: string) => useViewTabStore.getState().clearActive(viewId),
};
