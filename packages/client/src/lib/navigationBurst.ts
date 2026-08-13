/**
 * One logical navigation == one history entry (#446).
 *
 * `NavigationBurst` solves the "one back-step" problem: a single logical
 * navigation fires project -> view -> issue in sequence, which would otherwise
 * push three history entries. A burst allows the FIRST resulting URL write to
 * push and coalesces the rest into replaces, so the user gets one entry holding
 * the final URL. A "silent" burst (used while restoring from popstate) allows
 * no push at all — the entry already exists.
 *
 * Lives in `lib/` (#465) rather than `routes/boardRouteSync.ts`, where it used
 * to live: it is pure state with no dependency on the route-sync planners, and
 * both `routes/` (BoardPage.tsx, useBoardPageRoute.ts) and `hooks/`
 * (useInbox.ts, useBoardKeyboardShortcuts.ts) need to start a burst before a
 * multi-step deep link — a hook/component importing UP into `routes/` inverts
 * the intended layering. `routes/boardRouteSync.ts` re-exports these for its
 * own existing consumers.
 */

export interface NavigationBurst {
  /** Start a burst: the first URL write may push, later ones replace. */
  mark(now: number, windowMs?: number): void;
  /** Start a burst in which NO write may push (popstate restore). */
  markSilent(now: number, windowMs?: number): void;
  /** True when the next write must replace rather than push. */
  isCoalescing(now: number): boolean;
  /** Record that a push happened, so the rest of the burst coalesces. */
  notePush(now: number): void;
}

/** How long the steps of one logical navigation are treated as a single burst. */
export const NAVIGATION_BURST_MS = 1000;

export function createNavigationBurst(defaultWindowMs = NAVIGATION_BURST_MS): NavigationBurst {
  let openUntil = 0;
  let pushUsed = true;
  return {
    mark(now, windowMs = defaultWindowMs) {
      // Re-marking INSIDE an open burst only extends it — the steps of one
      // logical navigation each mark, and must still share a single entry.
      if (now >= openUntil) pushUsed = false;
      openUntil = now + windowMs;
    },
    markSilent(now, windowMs = defaultWindowMs) {
      openUntil = now + windowMs;
      pushUsed = true;
    },
    isCoalescing(now) {
      return now < openUntil && pushUsed;
    },
    notePush(now) {
      if (now < openUntil) pushUsed = true;
    },
  };
}

/**
 * Shared by every place that starts a multi-step navigation: the three
 * CustomEvent handlers (SELECT_PROJECT / NAVIGATE_VIEW / FOCUS_ISSUE) and the
 * popstate restore. They live in different modules, so the burst is a module
 * singleton rather than hook state.
 */
export const navigationBurst = createNavigationBurst();

/** Mark that a programmatic, multi-step navigation is starting. */
export function markProgrammaticNavigation(now: number = Date.now()): void {
  navigationBurst.mark(now);
}
