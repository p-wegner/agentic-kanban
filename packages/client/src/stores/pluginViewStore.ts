// Which surface the "Plugins" view is showing: one specific plugin's capabilities,
// or the marketplace (install + browse). Lives in a store rather than view-mode
// state because two distant components drive it — the toolbar's Plugins dropdown
// tab picks, the plugin panel auto-resolves a default — and threading it through
// BoardPage props would touch every layer in between for one string.
import { create } from "zustand";

export type PluginViewSelection =
  | { kind: "plugin"; slug: string }
  | { kind: "marketplace" };

interface PluginViewState {
  selection: PluginViewSelection | null;
  /** Bumped by "Install plugin…" so the marketplace focuses its install input. */
  installFocusNonce: number;
  setSelection: (selection: PluginViewSelection | null) => void;
  openMarketplace: (opts?: { focusInstall?: boolean }) => void;
}

export const usePluginViewStore = create<PluginViewState>((set) => ({
  selection: null,
  installFocusNonce: 0,
  setSelection: (selection) => set({ selection }),
  openMarketplace: (opts) =>
    set((s) => ({
      selection: { kind: "marketplace" },
      installFocusNonce: opts?.focusInstall ? s.installFocusNonce + 1 : s.installFocusNonce,
    })),
}));
