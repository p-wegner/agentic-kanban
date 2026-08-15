import type { PluginLoopProgressStep } from "@agentic-kanban/shared/lib/plugin-manifest";
import { parsePluginLoopUnitKey } from "@agentic-kanban/shared/lib/plugin-manifest";
import type { LoopIssueRow } from "../repositories/plugins.repository.js";

/**
 * Override a planner's "generating" claim with what the board can actually see (#479/#481).
 *
 * A loop's `plan` command only ever reports a step as `"generating"` because a ticket for it
 * exists — it has no way to know whether an agent is live, whether the ticket was never started
 * at all, or whether the agent already exited. Three genuinely different situations therefore
 * rendered identically as a spinner + "running": a step whose ticket is merely planned (nobody
 * has clicked Start, or Start Mode is manual), a step a workspace is genuinely working, and a
 * step whose workspace exited with no commits and will never advance on its own (#479's measured
 * shape — `state: "generating"`, `stranded: false`, 30 minutes after the agent was gone).
 *
 * This runs AFTER `listPluginLoopIssues` has already computed `hasAnyWorkspace`/`hasLiveWorkspace`
 * per ticket (the same fields `openTicketRefs.stranded` is built from — #479's other half fixed
 * the definition of "live" itself, in the repository), so the two signals agree by construction:
 * a step this function calls `"stalled"` is exactly the ticket `openTicketRefs` reports stranded.
 *
 * Only ever downgrades a planner's OWN `"generating"` — every other state (`done`,
 * `awaiting-approval`, `needs-revision`, `locked`, `failed`, `pending`, or an already-reconciled
 * `"planned"`/`"stalled"`) is the planner's or a prior pass's own claim and is left untouched. A
 * step with no matching open ticket (already terminal, or the planner is ahead of the board's
 * read) is likewise left as reported — there is nothing here to contradict it with.
 */
export function reconcileProgressStepStates(
  steps: PluginLoopProgressStep[],
  openTickets: Pick<LoopIssueRow, "externalKey" | "hasAnyWorkspace" | "hasLiveWorkspace">[],
): PluginLoopProgressStep[] {
  return steps.map((step) => {
    if (step.state !== "generating") return step;
    // Unit ids and step ids share the convention `isLoopUnitAccountedForByPlanner` already
    // relies on: a unit belongs to a step when it EQUALS the step id or is that id followed by
    // a `:` version separator (`step-1:v2`).
    const ticket = openTickets.find((t) => {
      const unitId = parsePluginLoopUnitKey(t.externalKey)?.unitId;
      return unitId != null && (unitId === step.id || unitId.startsWith(`${step.id}:`));
    });
    if (!ticket) return step;
    if (ticket.hasLiveWorkspace) return step; // a live workspace really is generating — leave it
    if (ticket.hasAnyWorkspace) return { ...step, state: "stalled" }; // #479 — exited, nothing landed
    return { ...step, state: "planned" }; // #481 — ticketed, no workspace ever provisioned
  });
}
