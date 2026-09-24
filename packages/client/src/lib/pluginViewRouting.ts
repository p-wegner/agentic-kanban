/**
 * Pure decision core for `hooks/usePluginViewRouting.ts` (#1227), split out per
 * the `lib/<feature>.ts` convention so the fallback logic is testable without
 * rendering a hook.
 */

export interface PluginSlugFallbackItem {
  pluginSlug: string;
  pluginName: string;
}

export interface PendingPluginViewRequest {
  slug: string;
  viewId: string;
}

export type PluginSlugFallbackDecision =
  /** `pluginSlug` already names a plugin present in `items` — nothing to do. */
  | { action: "none" }
  /** No plugin picked, or `pluginSlug` names one not in `items` — adopt `slug`. */
  | {
      action: "fallback";
      slug: string;
      /** Set only when a NAMED (as opposed to absent) slug was unresolvable. */
      toastMessage: string | null;
      /**
       * A pending `requestedViewId` naming the slug being abandoned is dead —
       * `pluginSlug` will never again equal that slug once this fallback
       * lands, so `usePluginViewDeepLink` would never consume it. Left
       * uncleared it stays pending indefinitely and can fire LATER against an
       * unrelated selection, if that same slug becomes reachable again in the
       * same session (a plugin enabled mid-session, a manual rail click).
       */
      clearRequestedViewId: boolean;
    };

/**
 * No plugin picked yet (fresh navigation), OR a deep link named a slug that is
 * not actually enabled here (a stale/mistyped `/plugin-views/<slug>` URL) →
 * adopt the first plugin present, same as the "nothing picked" case.
 */
export function planPluginSlugFallback(params: {
  pluginSlug: string | null;
  items: PluginSlugFallbackItem[];
  requestedViewId: PendingPluginViewRequest | null;
}): PluginSlugFallbackDecision {
  const { pluginSlug, items, requestedViewId } = params;
  const known = pluginSlug ? items.some((item) => item.pluginSlug === pluginSlug) : false;
  if (pluginSlug && known) return { action: "none" };
  const first = items[0];
  if (!first) return { action: "none" }; // nothing to fall back to — the empty-surface state covers this
  return {
    action: "fallback",
    slug: first.pluginSlug,
    toastMessage:
      pluginSlug && !known ? `Unknown plugin "${pluginSlug}" — showing ${first.pluginName} instead.` : null,
    clearRequestedViewId: pluginSlug !== null && requestedViewId !== null && requestedViewId.slug === pluginSlug,
  };
}
