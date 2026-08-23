import type { ViewTabDescriptor } from "./viewTabs.js";

/**
 * The group-header rule of the shared tab strip (#742).
 *
 * `ViewTabBar` renders an optional group label ("Flow", "Agents") before the first
 * tab of each run of same-group tabs. That was a stateful fold living inside the
 * `.map()` of a JSX return — the one place in the client where it could not be
 * asserted without a renderer, which is exactly #742's point stated about a rule
 * small enough to fix. Moving it here costs nothing and makes the contract below
 * a test instead of a comment.
 *
 * The rule is deliberately RUN-based, not set-based: it compares each tab's group
 * against the previous tab's group only. So an ungrouped tab between two tabs of
 * the same group resets the run and the group gets a second header. That is the
 * behaviour the tab bar has always had (interleaved groups are not a shape any
 * `ViewTabSet` in `viewTabs.ts` declares), and it is pinned by test rather than
 * left to be re-derived from the JSX.
 */
export interface ViewTabBarEntry {
  /** The tab to render. */
  tab: ViewTabDescriptor;
  /** Group label to render immediately before this tab, or `undefined` for none. */
  groupHeader?: string;
}

/** Annotate each tab with the group header that precedes it, if any. */
export function withViewTabGroupHeaders(
  tabs: readonly ViewTabDescriptor[],
): readonly ViewTabBarEntry[] {
  let previousGroup: string | undefined;
  return tabs.map((tab) => {
    const groupHeader = tab.group && tab.group !== previousGroup ? tab.group : undefined;
    previousGroup = tab.group;
    return groupHeader ? { tab, groupHeader } : { tab };
  });
}
