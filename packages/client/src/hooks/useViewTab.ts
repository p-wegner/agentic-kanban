import { useCallback, useEffect, useState } from "react";
import { useViewTabStore, viewTabActions } from "../stores/viewTabStore.js";
import { buildAppPath, parseAppPath } from "../lib/appRoutes.js";
import { getDefaultViewTab, getViewTabIds } from "../lib/viewTabs.js";

/**
 * Active-tab state for a tabbed container view (#234/#235), as a real URL
 * dimension (#446).
 *
 * The tab set and the default come from VIEW_TAB_REGISTRY, not from the call
 * site — the router reads the same registry, so a URL can never name a tab the
 * container does not have (and vice versa).
 *
 * Resolution order at mount: a pending viewTabStore request (palette action,
 * inbound route, popstate) wins, then the tab segment in the path, then the
 * legacy `?tab=` query param, then the registry default.
 *
 * Selecting a tab does NOT write the URL here: it publishes the tab to the
 * store and useBoardPageRoute's sync effect writes the canonical path. That is
 * the same state-drives-URL rule the project/view/issue dimensions follow, and
 * it is what gives a tab switch exactly one history entry.
 */
export function useViewTab<T extends string>(viewId: string): [T, (tab: T) => void] {
  const isValid = useCallback(
    (t: string | null | undefined): t is T => !!t && getViewTabIds(viewId).includes(t),
    [viewId],
  );

  const requested = useViewTabStore((s) => s.requested[viewId]);

  const [tab, setTab] = useState<T>(() => {
    const fromPath = parseAppPath(window.location.pathname);
    // Only a tab the PATH NAMED outranks `?tab=`. `parseAppPath` resolves the
    // tab, so a container view always reports one — testing validity alone made
    // the defaulted tab of a tabless path (`/analytics` → "throughput") beat an
    // explicit `?tab=burndown`, and the legacy branch became unreachable.
    if (fromPath.view === viewId && fromPath.tabIsExplicit && isValid(fromPath.tab)) return fromPath.tab;
    const fromQuery = new URLSearchParams(window.location.search).get("tab");
    if (isValid(fromQuery)) return fromQuery;
    if (fromPath.view === viewId && isValid(fromPath.tab)) return fromPath.tab;
    return (getDefaultViewTab(viewId) ?? getViewTabIds(viewId)[0] ?? "") as T;
  });

  // Consume a one-shot request (may arrive at mount or while already showing).
  useEffect(() => {
    if (requested === undefined) return;
    if (isValid(requested)) setTab(requested);
    viewTabActions.clear(viewId);
  }, [requested, viewId, isValid]);

  // Publish the tab so the router can put it in the URL; withdraw it on unmount
  // so a view switch does not leave a stale tab claiming the address bar.
  useEffect(() => {
    viewTabActions.setActive(viewId, tab);
  }, [viewId, tab]);
  useEffect(() => () => viewTabActions.clearActive(viewId), [viewId]);

  // Legacy `?tab=` links are still honoured above, but the param is dropped on
  // arrival — the path segment is the canonical form, and keeping both would
  // leave two disagreeing statements of the same fact in one URL.
  //
  // The param is not merely deleted: the tab it asked for is written INTO the
  // path in the same replaceState. Deleting it alone left the path naming the
  // default tab, so the route sync wrote that first and then PUSHED the real
  // tab — one inbound link, two history entries, and Back landing on a tab the
  // user never asked for.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("tab")) return;
    url.searchParams.delete("tab");
    const parsed = parseAppPath(url.pathname);
    const pathname =
      parsed.view === viewId && isValid(tab)
        ? buildAppPath({
            projectSlug: parsed.projectSlug,
            view: parsed.view,
            tab,
            issueNumber: parsed.issueNumber,
            panel: parsed.panel,
          })
        : url.pathname;
    window.history.replaceState(null, "", `${pathname}${url.search}${url.hash}`);
    // Mount-only: a later tab change is the route sync's job, not a rewrite.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [tab, setTab as (tab: T) => void];
}
