/**
 * Plugin-loop VIEW types, declared in `lib/` rather than in the component that renders them.
 *
 * #694 — `9d9cce93be` drove the client's upward type-only edges (a `lib/` or `hooks/` module
 * importing from `components/` or `routes/`) from 19 to 0 by moving declarations down. HEAD had
 * regressed to 1: `lib/gateCardPolicy.ts` imported `PluginCheck`, `PluginGate` and
 * `PluginGateAction` from `../components/PluginLoopExtras.js`.
 *
 * The regression was invisible because the enforcement is: the depcruise rule
 * `client-hooks-not-up-to-components-or-routes` deliberately EXEMPTS type-only imports (its own
 * comment says type imports are erased), and `tsPreCompilationDeps: false` means depcruise cannot
 * see them at all. So the rule that names this exact direction is structurally blind to the
 * type-only half of it. `client-upward-type-edge-ratchet.test.ts` is what actually holds the line
 * now — a text scan, which is the only thing that can see an edge the resolver erases.
 *
 * These three are the ones `gateCardPolicy.ts` needs. `PluginLoopExtras.tsx` re-exports them so
 * every existing `from "./PluginLoopExtras.js"` import keeps resolving — that re-export has real
 * consumers (`GateCard.tsx`, `PluginActionPanes.tsx`, and four test files), so it is a
 * compatibility seam rather than a dead shim.
 */

export type PluginGateAction = { id: string; label: string; input?: "text" };

export type PluginGate = {
  id: string;
  question: string;
  artifacts?: string[];
  actions: PluginGateAction[];
};

export type PluginCheck = { name: string; verdict: "pass" | "warn" | "fail"; detail?: string };
