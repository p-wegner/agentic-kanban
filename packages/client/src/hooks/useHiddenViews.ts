import { useCallback, useEffect, useState } from "react";
import { getSettings, setSettings } from "../lib/settingsStore.js";
import {
  parseHiddenViews,
  serializeHiddenViews,
  UNHIDEABLE_VIEWS,
  type ViewMode,
} from "../lib/viewRegistry.js";

/**
 * Per-project view visibility (#233).
 *
 * `VIEW_REGISTRY` holds 41 views — 14 primary toolbar tabs plus 27 behind "More" — and until now
 * there was NO mechanism to hide any of them: no pref, no gating anywhere in client, server or
 * shared. Curating the toolbar meant editing `viewRegistry.tsx` and rebuilding, on a board whose
 * whole premise is per-project configuration.
 *
 * Deliberately its own hook rather than another field on `useBoardPreferences`: the hidden set is
 * read by the toolbar, the command palette, the shortcut overlay and the key handler, and several
 * of those do not want the rest of that hook's monitor/WIP/aging state (or its polling).
 */
export interface HiddenViewsState {
  hidden: Set<ViewMode>;
  /** False until the first read resolves — render the full toolbar until then, never a stripped one. */
  loaded: boolean;
  setHidden: (next: Iterable<ViewMode>) => Promise<void>;
  toggle: (view: ViewMode, hide: boolean) => Promise<void>;
}

export function hiddenViewsKey(projectId: string): string {
  return `hidden_views_${projectId}`;
}

export function useHiddenViews(projectId: string | null): HiddenViewsState {
  const [hidden, setHiddenState] = useState<Set<ViewMode>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!projectId) {
        // No project => nothing is hidden. Not an error state: the board renders before a project
        // resolves, and stripping the toolbar in that window would flicker views out and back in.
        if (!cancelled) { setHiddenState(new Set()); setLoaded(true); }
        return;
      }
      try {
        const settings = await getSettings();
        if (!cancelled) setHiddenState(parseHiddenViews(settings[hiddenViewsKey(projectId)]));
      } catch {
        if (!cancelled) setHiddenState(new Set());
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const setHidden = useCallback(async (next: Iterable<ViewMode>) => {
    // `serializeHiddenViews` drops anything unhideable, so the guard holds even for a caller that
    // passes `kanban` — the picker is not the only writer (CLI/MCP can set the pref too).
    const value = serializeHiddenViews(next);
    const applied = parseHiddenViews(value);
    setHiddenState(applied);
    if (!projectId) return;
    await setSettings({ [hiddenViewsKey(projectId)]: value }).catch(() => {});
  }, [projectId]);

  const toggle = useCallback(async (view: ViewMode, hide: boolean) => {
    if (hide && UNHIDEABLE_VIEWS.includes(view)) return;
    const next = new Set(hidden);
    if (hide) next.add(view); else next.delete(view);
    await setHidden(next);
  }, [hidden, setHidden]);

  return { hidden, loaded, setHidden, toggle };
}
