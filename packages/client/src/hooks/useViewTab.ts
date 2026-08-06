import { useCallback, useEffect, useState } from "react";
import { useViewTabStore, viewTabActions } from "../stores/viewTabStore.js";

/**
 * Active-tab state for a tabbed container view (#234/#235).
 *
 * Resolution order: a pending viewTabStore request (palette action / legacy
 * deep-link route) wins, then the `?tab=` query param, then `defaultTab`.
 * Selecting a tab mirrors it into `?tab=` via replaceState so the URL stays a
 * shareable deep link; the param is removed again when the container unmounts
 * so it never leaks onto unrelated views.
 */
export function useViewTab<T extends string>(
  viewId: string,
  tabIds: readonly T[],
  defaultTab: T,
): [T, (tab: T) => void] {
  const isValid = useCallback(
    (t: string | null | undefined): t is T => !!t && (tabIds as readonly string[]).includes(t),
    [tabIds],
  );

  const requested = useViewTabStore((s) => s.requested[viewId]);

  const [tab, setTab] = useState<T>(() => {
    const fromQuery = new URLSearchParams(window.location.search).get("tab");
    return isValid(fromQuery) ? fromQuery : defaultTab;
  });

  // Consume a one-shot request (may arrive at mount or while already showing).
  useEffect(() => {
    if (requested === undefined) return;
    if (isValid(requested)) setTab(requested);
    viewTabActions.clear(viewId);
  }, [requested, viewId, isValid]);

  const selectTab = useCallback((next: T) => {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  }, []);

  // Drop `?tab=` when the container unmounts (view switch) so the param
  // doesn't linger on views that don't read it.
  useEffect(
    () => () => {
      const url = new URL(window.location.href);
      if (url.searchParams.has("tab")) {
        url.searchParams.delete("tab");
        window.history.replaceState(null, "", url);
      }
    },
    [],
  );

  return [tab, selectTab];
}
