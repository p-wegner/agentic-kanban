import { useEffect, useMemo } from "react";
import { showToast } from "../lib/toast.js";
import { planPluginSlugFallback } from "../lib/pluginViewRouting.js";

/**
 * #1227 subrouting effects for PluginViewsPanel, pulled out of the component
 * to keep its own extent under the function-nloc ratchet (#763) — none of
 * this is reused elsewhere, but three one-shot effects belong beside each
 * other rather than inline in an already-large component.
 */

interface PluginSurfaceItem {
  pluginSlug: string;
  pluginName: string;
}

interface PluginSurfaceLike {
  views: PluginSurfaceItem[];
  loops: PluginSurfaceItem[];
  scripts: PluginSurfaceItem[];
  skills: PluginSurfaceItem[];
}

interface UsePluginSlugFallbackOptions {
  loading: boolean;
  /** The slug named by the URL/store selection, or null when nothing is picked yet. */
  pluginSlug: string | null;
  /** The WHOLE surface (unfiltered) — the fallback needs the first plugin
   * project-wide, not the slice a not-yet-resolved slug would filter down to. */
  surface: PluginSurfaceLike;
  setStoreSelection: (selection: { kind: "plugin"; slug: string }) => void;
  /** A pending `requestViewId` naming the SAME unresolvable slug (#1227) is
   * for a plugin we are about to navigate away from — see below. */
  requestedViewId: { slug: string; viewId: string } | null;
  clearRequestedViewId: () => void;
}

/**
 * No plugin picked yet (fresh navigation), OR a deep link named a slug that is
 * not actually enabled here (a stale/mistyped `/plugin-views/<slug>` URL) →
 * adopt the first plugin present, same as the "nothing picked" case. Fires
 * once per unresolvable slug: once the fallback selection lands, `pluginSlug`
 * becomes a real one and `known` goes true.
 *
 * A `requestedViewId` naming that same unresolvable slug is cleared here too
 * (rather than left for `usePluginViewDeepLink` to consume) — that hook only
 * fires once `pluginSlug` matches the request, which for a slug that will
 * never resolve is never. Left alone, it stayed pending indefinitely and
 * could fire LATER against an unrelated selection: if the same slug becomes
 * genuinely reachable afterwards (a plugin enabled mid-session, a manual rail
 * click), the stale request replayed and silently overrode that unrelated
 * navigation.
 */
export function usePluginSlugFallback({
  loading,
  pluginSlug,
  surface,
  setStoreSelection,
  requestedViewId,
  clearRequestedViewId,
}: UsePluginSlugFallbackOptions): void {
  const items = useMemo(
    () => [...surface.views, ...surface.loops, ...surface.scripts, ...surface.skills],
    [surface],
  );
  useEffect(() => {
    if (loading) return;
    const decision = planPluginSlugFallback({ pluginSlug, items, requestedViewId });
    if (decision.action === "none") return;
    if (decision.toastMessage) showToast(decision.toastMessage, "warning");
    if (decision.clearRequestedViewId) clearRequestedViewId();
    setStoreSelection({ kind: "plugin", slug: decision.slug });
  }, [loading, pluginSlug, items, setStoreSelection, requestedViewId, clearRequestedViewId]);
}

interface DeepLinkView {
  pluginSlug: string;
  id: string;
}

interface UsePluginViewDeepLinkOptions<TView extends DeepLinkView> {
  loading: boolean;
  requestedViewId: { slug: string; viewId: string } | null;
  pluginSlug: string | null;
  views: TView[];
  clearRequestedViewId: () => void;
  /** Referentially stable — selects and starts the resolved view. */
  onResolved: (view: TView) => void;
}

/**
 * A pasted `/plugin-views/<slug>/<view-id>` URL asked for a specific iframe
 * view. Runs after the surface has loaded and the shown plugin matches the
 * request; one-shot regardless of outcome — an unresolvable view id falls
 * back to whatever the auto-select effect already landed on, with a notice,
 * rather than looping forever waiting for a view that will never arrive.
 */
export function usePluginViewDeepLink<TView extends DeepLinkView>({
  loading,
  requestedViewId,
  pluginSlug,
  views,
  clearRequestedViewId,
  onResolved,
}: UsePluginViewDeepLinkOptions<TView>): void {
  useEffect(() => {
    if (loading || !requestedViewId || requestedViewId.slug !== pluginSlug) return;
    const target = views.find((v) => v.pluginSlug === requestedViewId.slug && v.id === requestedViewId.viewId);
    clearRequestedViewId();
    if (!target) {
      showToast(`Unknown plugin view "${requestedViewId.viewId}" — showing the default instead.`, "warning");
      return;
    }
    onResolved(target);
  }, [loading, requestedViewId, pluginSlug, views, clearRequestedViewId, onResolved]);
}

interface UseReportActivePluginViewIdOptions {
  /** The iframe view id the panel currently shows, or null when it isn't an iframe pane. */
  activeViewId: string | null;
  setStoreActiveViewId: (viewId: string | null) => void;
}

/**
 * Report the currently-shown iframe view id to the store (#1227) so the route
 * hook can name it in the URL, and clear it on unmount so the NEXT plugin
 * panel mount (e.g. switching to the marketplace) never inherits a stale id.
 */
export function useReportActivePluginViewId({ activeViewId, setStoreActiveViewId }: UseReportActivePluginViewIdOptions): void {
  useEffect(() => {
    setStoreActiveViewId(activeViewId);
  }, [activeViewId, setStoreActiveViewId]);
  useEffect(() => () => setStoreActiveViewId(null), [setStoreActiveViewId]);
}
