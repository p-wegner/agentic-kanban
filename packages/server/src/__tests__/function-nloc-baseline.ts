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
 *
 * ── Third disclosed movement (2026-08-25, #887 session probe) ───────────────────────────
 *
 *   createRemoteAgentService    609 -> 609  Net zero, and not by luck: the hello
 *                                          reverse-reconcile moved out to
 *                                          agent-remote-liveness.ts, which now owns BOTH ways
 *                                          of asking "does this session exist on that worker?"
 *                                          — the free half (a hello enumerates) and the new one
 *                                          (ask, after silence). The lines that bought back
 *                                          were exactly what the new wiring cost.
 *   createWorkerAgentRunner     332 -> 343  Growth, named: the worker must REMEMBER every
 *                                          session id it was handed for `unknown` to be an
 *                                          authoritative answer. The ledger itself is a leaf
 *                                          (worker-session-registry.ts, which also composes
 *                                          the reply); what remains here is the construction
 *                                          plus three one-line notes on the assign/output/exit
 *                                          paths — the calls cannot be extracted from the code
 *                                          whose events they record.
 *
 * ── Fourth disclosed movement (2026-08-25, #874 remote turn refusal) ────────────────────
 *
 *   createSessionLifecycle      615 -> 616  Growth, named, and one line of it. `sendTurn`
 *                                          asked the process-liveness question BEFORE the
 *                                          placement question, so a session adopted onto a
 *                                          worker after a board restart was told its agent
 *                                          had exited while that agent was still working.
 *                                          The fix is one guard reading the dispatch proxy's
 *                                          new `placementOf`. It cannot be extracted: the
 *                                          refusal it produces is one of the three this
 *                                          function chooses between, and moving one arm out
 *                                          would split a decision across two files. The
 *                                          function still wants splitting for its own sake —
 *                                          this is not the ticket that does it.
 *                                          createRemoteAgentService stays at 609: its half
 *                                          of the fix is `tracksSession: isPidAlive` on the
 *                                          existing return line, an ALIAS rather than a
 *                                          second derivation, so the two answers cannot
 *                                          disagree and it costs nothing.
 *
 * ── Fifth disclosed movement (2026-08-25, #900 stdin-state recovery) ────────────────────
 *
 *   createSessionLifecycle      616 -> 627  Growth: `reattachSession` gained the seam to
 *                                          restore `turnStates` from a worker's session-probe
 *                                          answer instead of leaving a reattached remote
 *                                          session with none — the guard against acting on a
 *                                          stale/answered-too-late probe lives right beside
 *                                          the reattach it protects, so it could not move out
 *                                          without splitting the recovery decision from the
 *                                          state it decides.
 *   createRemoteAgentService    609 -> 637  Growth: `adoptSession` now asks the worker's probe
 *                                          for `stdinOpen`/idle instead of hard-coding `false`,
 *                                          and has to fold the "silence is not open" rule (#887)
 *                                          into the same adoption path that sets every other
 *                                          field of the adopted session.
 *   createWorkerAgentRunner     343 -> 349  Growth, small and named: the probe reply gained the
 *                                          two new fields (`stdinOpen`, `idle`) the board needs,
 *                                          read off the same runner state the rest of the probe
 *                                          answer already reads.
 *
 * ── Sixth disclosed movement (2026-09-01, #968 survivor probe) ─────────────────────────
 *
 *   createSessionLifecycle      618 -> 620  Growth, named, and two lines of it. A session was
 *                                          recorded `completed` exit 0 while its process kept
 *                                          working, so the workspace looked free and a relaunch
 *                                          put two agents in one worktree. The completed route
 *                                          now probes whether the process TREE outlived the exit
 *                                          event, and that needs the pid the session was SPAWNED
 *                                          as — `sessions.pid` may already have been overwritten
 *                                          by the relaunch, which would report a survivor on
 *                                          every clean handover. The two lines are the two ends
 *                                          of that: `state.launchedPids.set(...)` at the spawn
 *                                          site, and the read in `notifyExternalExit` that must
 *                                          happen BEFORE `teardownSessionState` clears the map.
 *                                          Neither can be extracted — each has to sit at the
 *                                          exact point in this function's flow where the value
 *                                          is available. The decision itself (which pid to ask
 *                                          about, in-memory vs persisted) DID move out, to the
 *                                          module-level `survivorProbePid`, and the probe and
 *                                          its verdict live entirely outside this file
 *                                          (`lib/process-tree.ts`, `exit-finalize.ts`).
 */
export const FUNCTION_NLOC_BASELINE: Record<string, number> = {
  "cli/commands/issue.ts::registerIssueCommand": 718,
  // 621 -> 623, a DELIBERATE raise (#815). The eight `latest_setup_*` columns moved off
  // `workspaces` into `workspace_setup_run`, and writing a child row costs an
  // `insertWorkspaceSetupRun(...)` call where eight inline field assignments used to sit.
  // Raised rather than worked around: the ring exists to stop unmanaged growth, not to make a
  // sanctioned extraction unlandable, and 2 nloc here bought 8 columns off the hottest table
  // in the board. It is still the largest entry in this ring and still wants splitting.
  "services/workspace-create.service.ts::createWorkspaceCreateService": 635,
  "services/issue.service.ts::createIssueService": 616,
  // 618 -> 620 (#968), disclosed in the sixth movement above.
  "services/session-manager/session-lifecycle.ts::createSessionLifecycle": 620,
  "services/workflow-fork.service.ts::createWorkflowForkService": 581,
  "cli/commands/workspace.ts::registerWorkspaceCommand": 573,
  "services/agent-remote.service.ts::createRemoteAgentService": 637,
  "cli/commands/session.ts::registerSessionCommand": 569,
  "services/project.service.ts::createProjectService": 564,
  // 529 -> 534, a DELIBERATE raise (#835). `mergeWorkspace` used to return the lock's
  // `Promise<unknown>`; it now declares `MergeWorkspaceResult` and publishes through
  // `publishMergeResponse`, and the lock-reuse path answers CONFLICT instead of handing back
  // the lock-lifetime promise (which always settles as `undefined` -- that was a live bug
  // returning an empty merge body). +5 nloc bought a typed return for every caller and took
  // 71 -> 65 grandfathered test files with it. Raised rather than worked around: the ring
  // exists to stop unmanaged growth, not to make a sanctioned typing fix unlandable.
  "services/workspace-merge.service.ts::createWorkspaceMergeService": 541,
  // 529 -> 430 (#906 fix-and-merge, god-module split): the whole train-strategy generator
  // (`runTrainStrategy` plus its `beginMergeTrain`/`finishMergeTrain`/`trainEligible` helpers)
  // moved to `services/merge-queue-train.ts` once the train-persistence work pushed this file
  // past the 1000-line hard ceiling. The factory still holds the sequential path in full.
  "services/merge-queue.service.ts::createMergeQueueService": 427,
  // 506 -> 474 in #806 batch 3: ten handlers dropped their inline type literal and guard
  // ladder for a `parseJsonBody(c, schema)` call.
  "routes/issues.ts::createIssuesRoute": 463,
  "services/workflow.service.ts::createWorkflowService": 456,
  // 418 -> 409, banked (#892): the skill-materialization body (resolveSkillFile +
  // materializeEnabledPluginSkills + the new materializeWorkspaceSkills) moved to
  // module-level `*Impl` functions taking `database` explicitly, so the relaunch seam in
  // `workspace-session.service.ts` can share the exact same logic without this factory
  // re-growing every time that shared logic changes. The factory now holds thin delegators.
  "services/workspace-provision.service.ts::createWorkspaceProvisionService": 393,
  // 404 -> 399, banked (#806): five hand-written body guards became one schema parse each.
  "routes/workspace-actions.ts::createWorkspaceActionsRoute": 403,
  // 349 -> 351 (#841): POSIX-only `detached: true` for a shell launch, closing the #836 gap.
  "worker/worker-agent-runner.ts::createWorkerAgentRunner": 351,
};

/**
 * A function at or above this many nloc must be in the baseline. 400 is chosen, and stated
 * rather than derived, for the reason above and in #763: the DMM's own 15-line threshold
 * classifies this codebase's ordinary architectural units as oversized, so a gate built on 15
 * would fail on arrival. Kept identical to the client ring's number on purpose — two rings
 * over one repo with two different definitions of "too long" would mean neither.
 */
export const LIST_THRESHOLD = 400;
