/**
 * Workspace lifecycle status vocabulary + the liveness predicates over it (#596).
 *
 * PURE — no drizzle, no `../schema`, no node builtins. That is the whole point of the
 * split: these predicates are needed by the CLIENT (stall badges, fleet stats, swimlanes,
 * the agent grid), and they used to live in `workspace-status.ts` alongside
 * `setWorkspaceStatus`, which value-imports `drizzle-orm` and the entire schema. Ten-plus
 * client modules deep-importing that file dragged drizzle and every table definition into
 * the browser bundle (#498 introduced the client edges; nothing flagged it because
 * depcruise's `client-no-drizzle-or-schema` rule only sees DIRECT edges and
 * `barrel-client-safety` only walked from `shared/src/index.ts`).
 *
 * Keep this module free of runtime imports. `workspace-status.ts` re-exports everything
 * here, so server-side callers are unaffected and there is still one definition.
 */

/** The stringly workspace lifecycle statuses observed across the codebase. */
export type WorkspaceStatus =
  | "active"
  | "idle"
  | "blocked"
  | "reviewing"
  | "fixing"
  | "closed"
  | "ready_for_merge"
  | "awaiting-plan-approval"
  | "error";

/**
 * Workspace statuses that are TERMINAL — the row no longer owns live resources (its
 * teardown has run), so "still live?" filters must EXCLUDE it. This is the SINGLE source
 * of truth shared by every such filter (the service-stack reaper's open-row query, the
 * service-state repository, the deferred-launch lifecycle recheck) so two liveness
 * definitions can never silently drift apart (#57).
 *
 * "merged" is NOT a member of WorkspaceStatus today — a merged workspace is
 * `status: "closed"` with `mergedAt` set — so the entry is currently DEAD. It is retained
 * deliberately: the previous divergence (the reaper filtered on `status != "closed"` while
 * the repository filtered on `["closed","merged"]`) agreed only by accident, and would
 * have split the instant someone added a real "merged" enum member — the reaper would then
 * treat merged workspaces as live and shield their stacks from reclamation forever.
 */
export const TERMINAL_WORKSPACE_STATUSES = ["closed", "merged"] as const;

/** True if a workspace status is terminal (see {@link TERMINAL_WORKSPACE_STATUSES}). */
export function isTerminalWorkspaceStatus(status: string | null | undefined): boolean {
  return status != null && (TERMINAL_WORKSPACE_STATUSES as readonly string[]).includes(status);
}

// --- Named liveness questions (#498) ------------------------------------------------
//
// TERMINAL_WORKSPACE_STATUSES made the terminal side single-source. The NON-terminal side
// was hand-rolled ~22 times in at least FOUR different sets. Those sets are not four
// attempts at one answer — they answer DIFFERENT questions, and collapsing them into a
// single "live" predicate would be wrong. The problem was that the QUESTION was never
// named at the call site. So: name the questions.

export const AGENT_RUNNING_STATUSES = ["active", "fixing"] as const satisfies readonly WorkspaceStatus[];

/**
 * Is an agent PROCESS running right now?
 *
 * `reviewing` is excluded: review runs as its own session, and callers asking this are
 * deciding whether to show a live-output affordance or detect a stall. Including
 * `reviewing` would make a reviewing workspace look stalled once its own agent exits.
 */
export function isAgentRunningStatus(status: string | null | undefined): boolean {
  return status != null && (AGENT_RUNNING_STATUSES as readonly string[]).includes(status);
}

export const WIP_OCCUPYING_STATUSES = ["active", "fixing", "reviewing"] as const satisfies readonly WorkspaceStatus[];

/**
 * Does this workspace consume a WIP slot?
 *
 * Broader than `isAgentRunningStatus`: a workspace awaiting review still occupies the
 * lane, so starting another ticket against it would exceed the configured WIP.
 * Under-counting here is what lets the monitor over-start.
 */
export function occupiesWipSlot(status: string | null | undefined): boolean {
  return status != null && (WIP_OCCUPYING_STATUSES as readonly string[]).includes(status);
}

/**
 * Does the row still own live RESOURCES (worktree, ports, service stack)?
 *
 * The complement of terminal, and deliberately the widest set — `idle` and `blocked`
 * workspaces still hold a worktree. Anything narrower risks reclaiming a directory out
 * from under a paused workspace.
 */
export function holdsLiveResources(status: string | null | undefined): boolean {
  return !isTerminalWorkspaceStatus(status);
}
