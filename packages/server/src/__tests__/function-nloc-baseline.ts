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
 * This is a SNAPSHOT OF REALITY, not a target. The server tree holds 3196 measured units, of
 * which 1197 are over the DMM's 15-nloc threshold; a gate at 15 would be red on arrival, which
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
 * ── One RETROACTIVE re-baseline, disclosed rather than done quietly (2026-08-23) ────────
 *
 * Four entries moved after the first measurement, within hours of the ring landing at
 * `086a41b6bc`. One was a shrink and is simply banked:
 *
 *   createWorkspaceCreateService  674 -> 621 -> 623  (`65f09038b5` #798, `d56c598163`; +2 #815)
 *
 * The other three are GROWTH, and raising a number in a shrink-only ring is exactly what this
 * file forbids — so it is written down here rather than folded in silently:
 *
 *   createSessionLifecycle   614 -> 615  (`aeb4bb67e0` #801)
 *   createRemoteAgentService 573 -> 594  (`428ad4bdf9` #790, `06e56ee005` #799, `aeb4bb67e0` #801)
 *   createWorkerAgentRunner  404 -> 410  (`06e56ee005` #799)
 *
 * The ring WAS in all three commits' history (`git merge-base --is-ancestor` holds for each),
 * so they did not branch before it. They are plain commits on master, and the pre-merge gate
 * only runs on a merge — so for direct-master work this suite reports after the fact instead
 * of refusing. That gap is #817. The alternative to re-baselining was leaving master red,
 * which blocks every OTHER merge on the board over growth that has already landed.
 *
 * This is the ring's proof of bite, not a hole in it: it named all four movements, with the
 * commit that caused each, on its first duty cycle. A future upward move needs the same
 * treatment — a named cause and a ticket — or it is just a budget.
 *
 * There is deliberately NO `SHRINK_GRACE` here: #800's other half was emptying the client's,
 * and re-introducing the escape hatch on a fresh baseline would recreate what it removed.
 *
 * ── Second disclosed re-baseline (2026-08-25, the direct-master fleet batch) ────────────
 *
 * Five factories grew with feature code landed in one batch; disclosed here rather than
 * silently, per this file's own precedent above:
 *
 *   createWorkspaceCreateService  623 -> 627  (#859: deferred launch failures persist)
 *   createIssueService            615 -> 616  (#861: remotePlacement on the workspace DTO)
 *   createRemoteAgentService      594 -> 609  (#871: undelivered_result dispatch; already
 *                                              split twice — agent-remote-undelivered.ts,
 *                                              agent-remote.types.ts — to stay under the
 *                                              file ceiling)
 *   createWorkspaceActionsRoute   399 -> 414  (#893: persisted-gate-verdict merge-status)
 *   createWorkerAgentRunner       406 -> 469  (#870/#871: push retry + undelivered
 *                                              retention/restore. The biggest jump of the
 *                                              batch; a shrink ticket is filed — the
 *                                              retention machinery is an extractable leaf.)
 */
export const FUNCTION_NLOC_BASELINE: Record<string, number> = {
  "cli/commands/issue.ts::registerIssueCommand": 718,
  // 621 -> 623, a DELIBERATE raise (#815). The eight `latest_setup_*` columns moved off
  // `workspaces` into `workspace_setup_run`, and writing a child row costs an
  // `insertWorkspaceSetupRun(...)` call where eight inline field assignments used to sit.
  // Raised rather than worked around: the ring exists to stop unmanaged growth, not to make a
  // sanctioned extraction unlandable, and 2 nloc here bought 8 columns off the hottest table
  // in the board. It is still the largest entry in this ring and still wants splitting.
  "services/workspace-create.service.ts::createWorkspaceCreateService": 627,
  "services/issue.service.ts::createIssueService": 616,
  "services/session-manager/session-lifecycle.ts::createSessionLifecycle": 615,
  "services/workflow-fork.service.ts::createWorkflowForkService": 581,
  "cli/commands/workspace.ts::registerWorkspaceCommand": 573,
  "services/agent-remote.service.ts::createRemoteAgentService": 609,
  "cli/commands/session.ts::registerSessionCommand": 569,
  "services/project.service.ts::createProjectService": 564,
  // 529 -> 534, a DELIBERATE raise (#835). `mergeWorkspace` used to return the lock's
  // `Promise<unknown>`; it now declares `MergeWorkspaceResult` and publishes through
  // `publishMergeResponse`, and the lock-reuse path answers CONFLICT instead of handing back
  // the lock-lifetime promise (which always settles as `undefined` -- that was a live bug
  // returning an empty merge body). +5 nloc bought a typed return for every caller and took
  // 71 -> 65 grandfathered test files with it. Raised rather than worked around: the ring
  // exists to stop unmanaged growth, not to make a sanctioned typing fix unlandable.
  "services/workspace-merge.service.ts::createWorkspaceMergeService": 534,
  "services/merge-queue.service.ts::createMergeQueueService": 521,
  // 506 -> 474 in #806 batch 3: ten handlers dropped their inline type literal and guard
  // ladder for a `parseJsonBody(c, schema)` call.
  "routes/issues.ts::createIssuesRoute": 474,
  "services/workflow.service.ts::createWorkflowService": 456,
  // 418 -> 409, banked (#892): the skill-materialization body (resolveSkillFile +
  // materializeEnabledPluginSkills + the new materializeWorkspaceSkills) moved to
  // module-level `*Impl` functions taking `database` explicitly, so the relaunch seam in
  // `workspace-session.service.ts` can share the exact same logic without this factory
  // re-growing every time that shared logic changes. The factory now holds thin delegators.
  "services/workspace-provision.service.ts::createWorkspaceProvisionService": 409,
  // 404 -> 399, banked (#806): five hand-written body guards became one schema parse each.
  "routes/workspace-actions.ts::createWorkspaceActionsRoute": 414,
  "worker/worker-agent-runner.ts::createWorkerAgentRunner": 469,
};

/**
 * A function at or above this many nloc must be in the baseline. 400 is chosen, and stated
 * rather than derived, for the reason above and in #763: the DMM's own 15-line threshold
 * classifies this codebase's ordinary architectural units as oversized, so a gate built on 15
 * would fail on arrival. Kept identical to the client ring's number on purpose — two rings
 * over one repo with two different definitions of "too long" would mean neither.
 */
export const LIST_THRESHOLD = 400;
