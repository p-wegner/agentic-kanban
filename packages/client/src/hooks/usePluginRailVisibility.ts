import { useCallback, useState } from "react";

/** Remembered rail visibility (#432) — an explicit choice outranks the width default. */
const RAIL_OPEN_STORAGE_KEY = "kanban.pluginRail.open";

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
export function usePluginRailVisibility() {
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

  return { railOpen, toggleRail, closeRailOnMobile };
}
