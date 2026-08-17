// Which surface the "Plugins" view is showing: one specific plugin's capabilities,
// or the marketplace (install + browse). Lives in a store rather than view-mode
// state because two distant components drive it — the toolbar's Plugins dropdown
// tab picks, the plugin panel auto-resolves a default — and threading it through
// BoardPage props would touch every layer in between for one string.
import { create } from "zustand";

export type PluginViewSelection =
  | { kind: "plugin"; slug: string }
  | { kind: "marketplace" }
  /**
   * An in-board doc from GET /api/docs/plugins — served only when a plugin it is about is
   * installed here, so a public board without those plugins never lists one.
   */
  | { kind: "guide"; file: string; title: string };

interface PluginViewState {
  selection: PluginViewSelection | null;
  /** Bumped by "Install plugin…" so the marketplace focuses its install input. */
  installFocusNonce: number;
  /** Which project the current `selection` belongs to — see `setActiveProject`. */
  projectId: string | null;
  /**
   * One-shot deep-link request (#300): "show THIS loop when the Plugins view opens".
   * Set by gate toast/notification/bell clicks, consumed (and cleared) by
   * PluginViewsPanel once the loop is present in the loaded surface.
   */
  loopFocus: { slug: string; loopName: string; nonce: number } | null;
  setSelection: (selection: PluginViewSelection | null) => void;
  openMarketplace: (opts?: { focusInstall?: boolean }) => void;
  focusLoop: (slug: string, loopName: string) => void;
  clearLoopFocus: () => void;
  /**
   * Scope the selection to a project. A plugin pick is only meaningful for the
   * project it was made in: carried onto another project it names a plugin that
   * may not even be installed there, and the panel then renders its "‹slug› adds
   * no views, loops, scripts or skills" state about a plugin the project never
   * had. Switching projects therefore DROPS a plugin pick (the panel re-resolves
   * a default from the new project's surface). A marketplace pick survives — the
   * marketplace is not project-scoped.
   */
  setActiveProject: (projectId: string | null) => void;
}

export const usePluginViewStore = create<PluginViewState>((set) => ({
  selection: null,
  installFocusNonce: 0,
  projectId: null,
  loopFocus: null,
  setSelection: (selection) => set({ selection }),
  focusLoop: (slug, loopName) =>
    set((s) => ({
      selection: { kind: "plugin", slug },
      loopFocus: { slug, loopName, nonce: (s.loopFocus?.nonce ?? 0) + 1 },
    })),
  clearLoopFocus: () => set({ loopFocus: null }),
  setActiveProject: (projectId) =>
    set((s) => {
      if (s.projectId === projectId) return s;
      return { projectId, selection: s.selection?.kind === "plugin" ? null : s.selection };
    }),
  openMarketplace: (opts) =>
    set((s) => ({
      selection: { kind: "marketplace" },
      installFocusNonce: opts?.focusInstall ? s.installFocusNonce + 1 : s.installFocusNonce,
    })),
}));
