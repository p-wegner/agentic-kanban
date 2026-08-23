import type { WorkspaceMergeExecutionResult } from "../../services/workspace-merge-execution.service.js";

/**
 * The shape a SUCCESSFUL `WorkspaceMergeService.mergeWorkspace(...)` actually resolves to.
 *
 * Its declared return type is `unknown`, and not because the response is unknowable: one
 * branch returns `RepoMergeLock.resultPromise`, declared `Promise<unknown>` in
 * `services/workspace-internals.ts`, and that widens the inferred return type of the whole
 * function. Until that field is typed, every caller — the suites here included — can only
 * re-state the shape it expects.
 *
 * Named once, aliased to the production type rather than hand-written, so the suites that
 * assert on a merge response neither invent their own inline shape nor drift from it (#808).
 */
export type MergeWorkspaceResponse = WorkspaceMergeExecutionResult["response"];
