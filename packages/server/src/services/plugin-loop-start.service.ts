import type { Database } from "../db/index.js";
import { getInProgressStatusId } from "../repositories/plugins.repository.js";
import { countActiveWip } from "../startup/monitor-auto-start.js";
import type { StartPolicy } from "./start-policy.service.js";
import type { CreateWorkspaceInput, CreateWorkspaceResult } from "./workspace-internals.js";

/**
 * Start the tickets a loop advance just planned, in the ADVANCE path (#351).
 *
 * Before this, gate resolution minted a Backlog ticket and depended on a monitor cycle noticing
 * it. Approval is an EVENT; making it depend on a POLL is what produced the measured 2.5-10 minute
 * "the board is frozen after I approved" window (26-28 min in earlier rounds), and no amount of
 * making the cycle faster removes it.
 *
 * ── Two honest limits, both deliberate ──
 *
 * 1. This does NOT wait for the agent to be running. `createWorkspace` runs the whole provisioning
 *    pipeline inline — `git worktree add`, devcontainer, the AWAITED blocking setup script
 *    (`pnpm install -r`), sibling worktrees, context packer — measured at 84s to 8+ minutes
 *    (`create-job.service.ts` records worktree-setup=294s, total=514s). Holding a butler approval
 *    reply open for that would be worse than the bug it fixes. So the launch is fired and not
 *    awaited, and the reported outcome is `starting`, never "running".
 * 2. It reports what it did, per ticket, so the caller can tell the user the truth instead of a
 *    single optimistic sentence (#354/#357). `queued-*` outcomes name what would have to change.
 *
 * Policy is NOT re-decided here: `resolveStartPolicy` stays the single source of truth (decision
 * 008), so a `manual`-mode loop still never auto-starts.
 */

export type LoopStartOutcome =
  | { issueId: string; issueNumber: number | null; outcome: "starting" }
  | { issueId: string; issueNumber: number | null; outcome: "queued-manual"; startMode: string }
  | { issueId: string; issueNumber: number | null; outcome: "queued-wip"; activeAgents: number; activeAgentsTarget: number }
  | { issueId: string; issueNumber: number | null; outcome: "queued-no-starter" }
  | { issueId: string; issueNumber: number | null; outcome: "start-failed"; detail: string };

export interface StartPlannedLoopTicketsArgs {
  database: Database;
  projectId: string;
  policy: StartPolicy;
  tickets: Array<{ issueId: string; issueNumber: number | null }>;
  createWorkspace?: (input: CreateWorkspaceInput) => Promise<CreateWorkspaceResult>;
}

export async function startPlannedLoopTickets(args: StartPlannedLoopTicketsArgs): Promise<LoopStartOutcome[]> {
  const { database, projectId, policy, tickets, createWorkspace } = args;
  if (tickets.length === 0) return [];

  if (!policy.autoStartUnblocked) {
    return tickets.map((t) => ({ ...t, outcome: "queued-manual" as const, startMode: policy.mode }));
  }
  if (!createWorkspace) {
    // A dep-less construction of the loop engine (some routes build one without the workspace
    // service). Reported rather than silently behaving like the old poll-dependent path.
    return tickets.map((t) => ({ ...t, outcome: "queued-no-starter" as const }));
  }

  const statusId = await getInProgressStatusId(projectId, database);
  // No "In Progress" lane means WIP is unmeasurable here; the monitor's own gate still applies on
  // its next pass, so decline rather than start past an unknown cap.
  if (!statusId) return tickets.map((t) => ({ ...t, outcome: "queued-no-starter" as const }));

  const target = policy.wip.activeAgentsTarget;
  let active = await countActiveWip(database, statusId);
  const outcomes: LoopStartOutcome[] = [];
  for (const ticket of tickets) {
    if (active >= target) {
      outcomes.push({ ...ticket, outcome: "queued-wip", activeAgents: active, activeAgentsTarget: target });
      continue;
    }
    try {
      // Fired, not awaited — see limit 1 in the module header. The rejection handler is attached
      // synchronously so a provisioning failure can never surface as an unhandled rejection (this
      // server logs those as [fatal]).
      void createWorkspace({ issueId: ticket.issueId }).catch((err: unknown) => {
        console.warn(
          `[plugin-loop] direct start of issue ${ticket.issueNumber ?? ticket.issueId} failed `
          + `(the monitor's auto-start pass remains the fallback):`,
          err instanceof Error ? err.message : String(err),
        );
      });
      // Counted optimistically: the ticket is on its way to In Progress, and counting it keeps a
      // batch of planned units from all starting past the cap in one pass.
      active += 1;
      outcomes.push({ ...ticket, outcome: "starting" });
    } catch (err) {
      outcomes.push({ ...ticket, outcome: "start-failed", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return outcomes;
}

/** One short, falsifiable sentence per outcome — what the butler and the loop surface should say. */
export function describeLoopStartOutcome(outcome: LoopStartOutcome): string {
  const ref = outcome.issueNumber !== null ? `#${outcome.issueNumber}` : outcome.issueId;
  switch (outcome.outcome) {
    case "starting":
      return `${ref} is starting now — its workspace is being provisioned (worktree + dependency install), `
        + `which takes a few minutes before the agent's first output.`;
    case "queued-manual":
      return `${ref} will NOT start on its own: this project's Start Mode is "${outcome.startMode}". `
        + `Start it from the board, or switch Start Mode to "monitor" in the Monitor view.`;
    case "queued-wip":
      return `${ref} is queued: ${outcome.activeAgents} of ${outcome.activeAgentsTarget} agent slots are in use. `
        + `It starts when a slot frees up.`;
    case "queued-no-starter":
      return `${ref} is queued for the next monitor pass.`;
    case "start-failed":
      return `${ref} could not be started (${outcome.detail}); the monitor's next auto-start pass will retry.`;
  }
}
