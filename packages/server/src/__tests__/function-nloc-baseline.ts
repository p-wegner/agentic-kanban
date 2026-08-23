/**
 * Baseline for `function-nloc-ratchet.test.ts` (#800, extending #763's client ring to the
 * server tree).
 *
 * Every server function whose own extent is >= LIST_THRESHOLD (400) non-blank, non-comment
 * lines, MEASURED on 2026-08-23 by the shared scanner
 * (`packages/shared/__tests__/helpers/function-nloc.ts`) — the SAME scanner the client ring
 * uses, verified to reproduce #763's client numbers key-for-key before this baseline was
 * taken. Nothing here was copied from a metrics report.
 *
 * This is a SNAPSHOT OF REALITY, not a target. The server tree holds 3167 measured units, of
 * which 1183 are over the DMM's 15-nloc threshold; a gate at 15 would be red on arrival, which
 * is exactly why #763 chose a stated 400 (see LIST_THRESHOLD's comment). The 16 entries below
 * are what a reader would call unreadable, and the property being enforced is only that they
 * may not get worse and no new one may join them unnoticed.
 *
 * Nearly every entry is a `createXService` factory body or a `registerXCommand` builder —
 * one call per exported operation, which is the architecture rather than a tangle. #763's
 * "the metric's threshold calls the architecture oversized" caveat applies here more strongly
 * than it does on the client.
 *
 * Only ever LOWER a number or delete a line. The ratchet fails on growth, on a listed
 * function that has vanished, and on a number that has become stale.
 *
 * There is deliberately NO `SHRINK_GRACE` here: #800's other half was emptying the client's,
 * and re-introducing the escape hatch on a fresh baseline would recreate what it removed.
 */
export const FUNCTION_NLOC_BASELINE: Record<string, number> = {
  "cli/commands/issue.ts::registerIssueCommand": 718,
  "services/workspace-create.service.ts::createWorkspaceCreateService": 674,
  "services/issue.service.ts::createIssueService": 615,
  "services/session-manager/session-lifecycle.ts::createSessionLifecycle": 614,
  "services/workflow-fork.service.ts::createWorkflowForkService": 581,
  "cli/commands/workspace.ts::registerWorkspaceCommand": 573,
  "services/agent-remote.service.ts::createRemoteAgentService": 573,
  "cli/commands/session.ts::registerSessionCommand": 569,
  "services/project.service.ts::createProjectService": 564,
  "services/workspace-merge.service.ts::createWorkspaceMergeService": 529,
  "services/merge-queue.service.ts::createMergeQueueService": 521,
  "routes/issues.ts::createIssuesRoute": 506,
  "services/workflow.service.ts::createWorkflowService": 456,
  "services/workspace-provision.service.ts::createWorkspaceProvisionService": 418,
  "routes/workspace-actions.ts::createWorkspaceActionsRoute": 404,
  "worker/worker-agent-runner.ts::createWorkerAgentRunner": 404,
};

/**
 * A function at or above this many nloc must be in the baseline. 400 is chosen, and stated
 * rather than derived, for the reason above and in #763: the DMM's own 15-line threshold
 * classifies this codebase's ordinary architectural units as oversized, so a gate built on 15
 * would fail on arrival. Kept identical to the client ring's number on purpose — two rings
 * over one repo with two different definitions of "too long" would mean neither.
 */
export const LIST_THRESHOLD = 400;
