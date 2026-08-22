/**
 * The shared vocabulary of the session-exit workflow (#700).
 *
 * `startup/exit-workflow.ts` is the monitor-engine module that decides what happens when an
 * agent session ends. Its dispatcher loads ONE snapshot of the workspace, prefs, project
 * statuses and merge policy, then hands that snapshot to whichever terminal handler the
 * classification selected. That snapshot type is the contract between the dispatcher and every
 * handler — including the ones that now live in their own modules beside this file — so it lives
 * here rather than in any one of them.
 *
 * Types only, deliberately: no queries, no side effects, nothing to import at runtime. A module
 * in `startup/exit/` that needs the snapshot takes it as a parameter and takes its `Database`
 * as an injected dependency, which is why none of them reach for the `db` singleton or write
 * raw drizzle (see `startup-persistence-boundary-ratchet.test.ts` — `startup/` has no
 * persistence boundary and the count may only shrink, so a decomposition must not add offenders).
 */
import type { projectStatuses, workspaces } from "@agentic-kanban/shared/schema";
import type { MergeGateToken } from "../../services/pre-merge-gate.service.js";
import type { MergeWorkspace } from "../merge-workflow.js";

/** Full workspace row, as the session-exit dispatcher reads it. */
export type WorkspaceRow = typeof workspaces.$inferSelect;

/** Project status row, used by the session-exit workflow handlers. */
export type StatusRow = typeof projectStatuses.$inferSelect;

/**
 * Per-call context for the session-exit workflow. Loaded once by the dispatcher
 * (`runWorkflowOnExit`) after the early short-circuits, then threaded to each
 * scenario handler so they all share one snapshot of the workspace, prefs,
 * project statuses and merge policy.
 */
export interface ExitContext {
  workspace: WorkspaceRow;
  projectId: string;
  issueId: string;
  skipAutoReview: boolean;
  sessionId: string;
  exitCode: number | null;
  now: string;
  prefMap: Map<string, string>;
  statuses: StatusRow[];
  findStatus: (name: string) => StatusRow | undefined;
  autoMergeEnabled: boolean;
  defaultBranch: string | null;
  autoMergeDisabledProjectIds: Set<string>;
}

/**
 * The auto-merge entry point, as the exit workflow is handed it. Injected rather than imported
 * (the merge workflow already imports this engine), so both the engine and every handler module
 * that lands a branch depend on this one signature instead of on `merge-workflow.ts` itself.
 */
export type AutoMergeFn = (
  workspace: MergeWorkspace,
  projectId: string,
  issueId: string,
  doneStatusId: string | null,
  now: string,
  gate: MergeGateToken,
) => Promise<void>;
