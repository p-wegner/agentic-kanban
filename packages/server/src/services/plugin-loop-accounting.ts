import type { PluginLoopGate, PluginLoopProgressStep } from "@agentic-kanban/shared";
import { parsePluginLoopUnitKey } from "@agentic-kanban/shared/lib/plugin-manifest";

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

/**
 * Which OPEN tickets genuinely belong to a round still in flight — i.e. which of them should
 * suppress the loop's gate card (#431).
 *
 * The render guard was a bare count: `loop.gate && loop.openTickets === 0`. `openTickets` counts
 * every non-terminal ticket of the loop INCLUDING THE ONE THE GATE IS ABOUT, so any ticket held
 * open by something other than the work itself takes the gate off the screen. Confirmed causally
 * on a live `mealplan` step-1 gate: with ticket #1 parked In Review the gate was absent from the
 * pane while fully present in the API (question, `approve` recommendation, checks all populated);
 * moving #1 to Done flipped the count 1 → 0 and the same card rendered unchanged.
 *
 * The normal path does reach `openTickets === 0` on its own — step 2 of the same run did. What
 * makes this worth fixing is WHICH cases don't: a review parked for a human, a blocked or refused
 * merge, an orphaned workspace from a crash. In exactly those cases the gate — the thing that
 * would tell the operator what to do — is the thing that disappears, silently, behind a pane that
 * looks like an ordinary running round.
 *
 * So the question becomes "is there open work the planner has NOT accounted for", asked per
 * ticket via the same unit↔step convention `isLoopUnitAccountedForByPlanner` already uses. A gate
 * whose own unit is the only thing open still renders; a genuinely stale gate from a round with
 * real work in it still does not.
 *
 * A ticket whose unit cannot be attributed counts as blocking: that is the conservative direction
 * (it preserves the old behaviour for anything unrecognised) and matches how `selectLoopStall`
 * treats the same unattributable row.
 */
export function gateBlockingTickets<T extends { externalKey?: string | null }>(
  gate: PluginLoopGate | null,
  progress: { steps: PluginLoopProgressStep[] } | null,
  openTickets: T[],
): T[] {
  if (!gate) return [];
  return openTickets.filter((ticket) => {
    const unitId = parsePluginLoopUnitKey(ticket.externalKey ?? null)?.unitId;
    if (!unitId) return true;
    return !isLoopUnitAccountedForByPlanner(unitId, gate, progress);
  });
}
