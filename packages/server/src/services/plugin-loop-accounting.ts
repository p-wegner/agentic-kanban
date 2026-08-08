import type { PluginLoopGate, PluginLoopProgressStep } from "@agentic-kanban/shared";

/**
 * Has the PLANNER already accounted for this unit's work? (#353, generalising #326.)
 *
 * #326 removed one instance of a contradiction — a "waiting for merge / Merge now" banner
 * rendered directly above a gate card for the SAME unit — with the reasoning "a gate means the
 * planner has SEEN this unit's artifacts in the main checkout, so 'the planner cannot see them
 * until the merge lands' is false". But it only compared against the CURRENT gate's id, so a unit
 * from an EARLIER step never aged out: measured on `kassenbuch`, step 1's long-merged workspace
 * kept claiming the banner while the pipeline sat at the step-3 gate, and would have kept it for
 * all six remaining steps.
 *
 * The same reasoning applies verbatim to every step the planner reports `done` — that IS the
 * planner saying it has seen the artifacts. `progress.steps[]` is already persisted in the advance
 * payload, so this needs no new state and no git call.
 *
 * Unit ids and step ids live in different namespaces (`step-3:v1` vs `step-3`), so a unit belongs
 * to a step when it equals the step id or is that id followed by a separator. That is a convention,
 * not a contract — hence the exact-match branch first, and no attempt to parse a version.
 *
 * Lives in its own module (#363) so `plugin-loop-stall.ts` can use it without importing
 * `plugin-loop.service.ts`, which imports the stall classifier — a cycle the arch gate rejects.
 * `plugin-loop.service.ts` re-exports it, so existing importers are unaffected.
 */
export function isLoopUnitAccountedForByPlanner(
  unitId: string,
  gate: PluginLoopGate | null,
  progress: { steps: PluginLoopProgressStep[] } | null,
): boolean {
  if (gate && unitId === gate.id) return true;
  for (const step of progress?.steps ?? []) {
    if (step.state !== "done") continue;
    if (unitId === step.id || unitId.startsWith(`${step.id}:`)) return true;
  }
  return false;
}
