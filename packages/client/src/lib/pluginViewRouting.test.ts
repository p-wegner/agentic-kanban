import { describe, expect, it } from "vitest";
import { planPluginSlugFallback } from "./pluginViewRouting.js";

const JIRA = { pluginSlug: "jira-sync", pluginName: "Jira Sync" };
const REQEXTRACT = { pluginSlug: "reqextract", pluginName: "Reqextract" };

describe("planPluginSlugFallback (#1227)", () => {
  it("does nothing when the slug already names a present plugin", () => {
    expect(
      planPluginSlugFallback({ pluginSlug: "jira-sync", items: [JIRA, REQEXTRACT], requestedViewId: null }),
    ).toEqual({ action: "none" });
  });

  it("adopts the first plugin with no toast when nothing is picked yet", () => {
    expect(planPluginSlugFallback({ pluginSlug: null, items: [JIRA, REQEXTRACT], requestedViewId: null })).toEqual({
      action: "fallback",
      slug: "jira-sync",
      toastMessage: null,
      clearRequestedViewId: false,
    });
  });

  it("adopts the first plugin WITH a toast for an unresolvable slug", () => {
    expect(
      planPluginSlugFallback({ pluginSlug: "does-not-exist", items: [JIRA, REQEXTRACT], requestedViewId: null }),
    ).toEqual({
      action: "fallback",
      slug: "jira-sync",
      toastMessage: 'Unknown plugin "does-not-exist" — showing Jira Sync instead.',
      clearRequestedViewId: false,
    });
  });

  it("does nothing when there is no plugin to fall back to", () => {
    expect(planPluginSlugFallback({ pluginSlug: "does-not-exist", items: [], requestedViewId: null })).toEqual({
      action: "none",
    });
  });

  it("clears a pending view-id request naming the SAME unresolvable slug being abandoned", () => {
    // The bug this covers: a stale /plugin-views/does-not-exist/dashboard deep
    // link redirects to the first real plugin, but the paired requestedViewId
    // was left in the store — if "does-not-exist" ever became reachable again
    // later in the same session, usePluginViewDeepLink would replay it against
    // an unrelated navigation.
    expect(
      planPluginSlugFallback({
        pluginSlug: "does-not-exist",
        items: [JIRA, REQEXTRACT],
        requestedViewId: { slug: "does-not-exist", viewId: "dashboard" },
      }),
    ).toEqual({
      action: "fallback",
      slug: "jira-sync",
      toastMessage: 'Unknown plugin "does-not-exist" — showing Jira Sync instead.',
      clearRequestedViewId: true,
    });
  });

  it("leaves a pending request for a DIFFERENT plugin alone", () => {
    // Not this fallback's concern — usePluginViewDeepLink will resolve it (or
    // find it dead) once/if pluginSlug ever becomes "jira-sync".
    expect(
      planPluginSlugFallback({
        pluginSlug: "does-not-exist",
        items: [JIRA, REQEXTRACT],
        requestedViewId: { slug: "jira-sync", viewId: "dashboard" },
      }),
    ).toEqual({
      action: "fallback",
      slug: "jira-sync",
      toastMessage: 'Unknown plugin "does-not-exist" — showing Jira Sync instead.',
      clearRequestedViewId: false,
    });
  });

  it("never clears a request when nothing was picked yet (no slug to compare)", () => {
    expect(
      planPluginSlugFallback({
        pluginSlug: null,
        items: [JIRA, REQEXTRACT],
        requestedViewId: { slug: "jira-sync", viewId: "dashboard" },
      }),
    ).toEqual({
      action: "fallback",
      slug: "jira-sync",
      toastMessage: null,
      clearRequestedViewId: false,
    });
  });
});
