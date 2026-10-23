/**
 * Release-train strategy for the merge queue (#904, #906) — split out of
 * `merge-queue.service.ts` (arch-review god-module gate, #906 fix-and-merge) once the
 * train-persistence work (`beginMergeTrain`/`finishMergeTrain`) pushed that file past the
 * 1000-line hard ceiling. This module owns everything specific to running ONE batch as a
 * release train; `createMergeQueueService` calls `createMergeTrainRunner` and dispatches to
 * it when `trainEligible` + the caller/classifier/pref opt in.
 */
import { gateBaseAloneOnce, runTrainStagingGate } from "./merge-queue-train-staging-gate.js";
import { trainGateWorkerName } from "./merge-train-placement.js";
import type { Database } from "../db/index.js";
import type { BoardEventSink } from "./board-events.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import * as gitService from "./git.service.js";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { getMergeQueueIssueRows, getMergeTrainMaxSizePref } from "../repositories/merge-queue.repository.js";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { resolveTrainOptInSize } from "./merge-train-window.js";
import { resolveRiskPosture, formatPostureNote, type RiskPosture } from "./risk-posture.service.js";
import {
  appendMergeTrainAttempt,
  countTrainsForProjectOnDate,
  createMergeTrain,
  getMergeTrain,
  listActiveMergeTrainsForProject,
  listRecentMergeTrainsForProject,
  updateMergeTrainState,
} from "../repositories/merge-train.repository.js";
import { decideAgeAbandonSplit } from "./merge-train-age-split.js";
import { runMergeTrain, formatTrainLabel, trainDateStamp, trainRefName, type OnTrainDropped } from "./merge-train.service.js";
import { isMergeTrainLabelLive, noteMergeTrainGateActivity, withMergeTrainGateActivity, registerLiveMergeTrain, unregisterLiveMergeTrain } from "./merge-train-live-registry.js";
import { cleanupTrainWorktreesForLabel, pinTrainRefsForLabel } from "./merge-train-worktrees.js";
import { describeInconclusiveGate, describeTrainGateRed, finalTrainStateFields, inconclusiveSkipEvents, isInconclusiveGate } from "./merge-queue-train-inconclusive.js";
export { describeTrainGateRed } from "./merge-queue-train-inconclusive.js";
import { finishFlushRun, type FlushRunSpec } from "./merge-train-flush-run.js";
import { provisionTrainGateSelector } from "./merge-train-gate-selector.js";
import { runPreMergeGate, looksLikeMissingDepsFailure } from "./pre-merge-gate.service.js";
import { runStaticTierGate } from "./static-tier.service.js"; // #1514: check:static before the suites
import { resolveWorktreeClaims, removeWorktreeUnlessShared } from "@agentic-kanban/shared/lib/worktree-claim";
import { randomUUID } from "node:crypto";
import { acquireQueueRepoLock, createSuspendableRepoLock, MERGE_TRAIN_REPO_LOCK_TIMEOUT_MS } from "./merge-queue-repo-lock.js";
import type { MergeQueueEvent, MergeQueuePlan } from "./merge-queue.service.js";
import type { MergeTrainAttemptDto, MergeTrainBaseVerdict, MergeTrainGateEvidenceDto, MergeTrainShepherdDto } from "@agentic-kanban/shared/types";
import { resolveMergeTrainRedPolicy, type MergeTrainRedPolicy } from "@agentic-kanban/shared/lib/merge-train-red-strategy";
import { type AgentFixGateVerdict, type AgentFixOutcome, type TrainAgentRunner } from "./merge-train-agent-fix.js";
import { createPlacedSessionRunner } from "./merge-train-session-runner.js";
import { buildTrainOnRed, createTrainShepherdKit } from "./merge-train-shepherd-wiring.js";
import { recordMergeTrainShepherd } from "../repositories/merge-train.repository.js";
import { getBaseBranchHealthForSha, isBaseHealthAnswer } from "../repositories/base-branch-health.repository.js";
import { getProjectSetupScript } from "../repositories/stack-profile.repository.js";
import { DEFAULT_SETUP_SCRIPT_TIMEOUT_MS, runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import { noteMergeGatePhase } from "./merge-job.service.js";
import { formatIneligibleNote, trainMemberIneligibility } from "./merge-release-partition.js";
import { resolveTrainReviewDecision, runTrainReview, type TrainReviewMember } from "./merge-train-review.service.js";
import { baseConflictProbe, clearTrainSiding, createTrainDropSendBack, partitionSidedMembers } from "./merge-train-siding.service.js";
import { BRANCH_ALONE_FAILURE_PREFIX } from "./auto-merge-breaker.js";
import { logTrainConflictClusters, sendTrainRedFeedback } from "./merge-train-red-feedback.js";
import {
  buildTrainGateEvidence,
  recordBoardingComments,
  recordFinishComments,
} from "./train-finish-evidence.service.js";

/**
 * How many ready members a project wants batched onto one train before it opts into the
 * train strategy at all (#904). `> 1` is the signal — a project that has never touched this
 * knob defaults to 1 (i.e. stays on the sequential path unless the caller explicitly asks
 * for `strategy: "train"`), since #905 owns the actual batching-window default of 4.
 *
 * #937: the DECISION is `resolveTrainOptInSize` (a pure prefMap resolver routed through
 * `resolveRiskPosture`); this is the thin DB-reading wrapper the existing async call sites
 * keep, the same split `resolveVerifyGateStrategy`/`resolveGateTier` uses. An explicit
 * `train_max_size_<projectId>` still wins, and `standard`/`strict` both resolve to 1 — so a
 * project on either stays on the sequential path exactly as before.
 */
export async function resolveProjectTrainMaxSize(projectId: string, database: Database): Promise<number> {
  const prefMap = toPrefMap(await getAllPreferencesCached(database).catch(() => []));
  return resolveTrainOptInSize(prefMap, projectId);
}

/**
 * As above, keeping the posture so the caller can name it when the POSTURE (not an explicit
 * pref) is what put this batch on a train — decision 017's visibility rule.
 */
export async function resolveTrainOptIn(
  projectId: string,
  database: Database,
): Promise<{ maxSize: number; posture: RiskPosture; fromPosture: boolean }> {
  const prefMap = toPrefMap(await getAllPreferencesCached(database).catch(() => []));
  const posture = resolveRiskPosture(prefMap, projectId);
  // Sourced from the posture only when there is NO explicit override — comparing the two
  // VALUES would misreport an operator who happens to have pinned the same number.
  const explicit = await getMergeTrainMaxSizePref(projectId, database).catch(() => undefined);
  const explicitParsed = Number.parseInt(explicit ?? "", 10);
  const hasExplicit = Number.isFinite(explicitParsed) && explicitParsed > 0;
  return { maxSize: resolveTrainOptInSize(prefMap, projectId), posture, fromPosture: !hasExplicit };
}

/**
 * Does this project's opt-in put an eligible batch on a train?
 *
 * The decision lives here rather than inline in `createMergeQueueService` because it is
 * about the TRAIN (it is the async half of `resolveTrainOptIn`, and the only caller that
 * cares about the posture-vs-explicit distinction), and because that function is on the
 * shrink-only nloc ring (#800) — #937's inline version pushed it past its baseline.
 *
 * `batchSize` is only for the log line: decision 017's visibility rule says that when the
 * POSTURE, not an explicit `train_max_size_<projectId>`, is what batched these workspaces,
 * the log has to say so and name the posture.
 */
export async function trainWantedForProject(
  projectId: string | null,
  database: Database,
  batchSize: number,
): Promise<boolean> {
  if (!projectId) return false;
  const optIn = await resolveTrainOptIn(projectId, database);
  const wants = optIn.maxSize > 1;
  if (wants && optIn.fromPosture) {
    console.log(
      `[merge-queue] batching ${batchSize} workspace(s) onto a train (max ${optIn.maxSize})` +
        formatPostureNote(optIn.posture),
    );
  }
  return wants;
}

/**
 * Are these members eligible for a single release train?
 *
 * v1 is deliberately narrow — a train must be provably one repo, one base. Multi-repo
 * workspaces merge all-or-nothing across siblings (`prevalidateSiblingMerges` /
 * `executeSiblingMerges`), and coordinating THAT across a batch is a separate problem; a
 * direct workspace has no branch to put on a train at all. Anything ineligible falls back
 * to the existing per-ticket path, which is slower but always correct.
 */
export function trainEligible(order: MergeQueuePlan["order"]): boolean {
  if (order.length < 2) return false;
  const first = order[0];
  return order.every(
    (ws) =>
      trainMemberIneligibility(ws) === null &&
      ws.repoPath === first.repoPath &&
      ws.baseBranch === first.baseBranch,
  );
}

/**
 * The train-vs-sequential dispatch decision for one `executeQueue` call (#904, #937, #1180).
 *
 * Eligibility (`trainEligible`) is about SHAPE (one repo, one base, all branches) and is
 * independent of the classifier — an overlap-free, fully independent batch is exactly as
 * eligible as an `integration-union` cluster. `opts.strategy === "sequential"` is an explicit
 * escape hatch that always wins; short of that, the train is taken when the caller asks for it,
 * the classifier already recommends it, OR the project has opted in via `train_max_size` (which
 * falls back to the risk posture's `trainMaxSize`, #937).
 *
 * #1180: a batch of >= 2 that does NOT train says why, in one `[merge-queue]` line — the
 * orchestrator used to log "train window closed … releasing 13" and then merge them one by one
 * with nothing in between naming the ineligible member or the missing opt-in. Lives here rather
 * than inline in `createMergeQueueService` because that function is on the shrink-only nloc ring.
 */
export async function pickQueueStrategy(
  plan: MergeQueuePlan,
  opts: { strategy?: "sequential" | "train" },
  database: Database,
): Promise<"train" | "sequential"> {
  if (opts.strategy === "sequential") return "sequential";
  const eligible = trainEligible(plan.order);
  const wantsTrain = opts.strategy === "train" || plan.recommendedStrategy === "integration-union";
  if (wantsTrain && eligible) return "train";
  if (plan.order.length < 2) return "sequential";

  const issueRows = await getMergeQueueIssueRows([plan.order[0].issueId], database);
  const projectId = issueRows[0]?.projectId ?? null;
  if (eligible && await trainWantedForProject(projectId, database, plan.order.length)) return "train";
  console.log(`[merge-queue] no train for project ${projectId ?? "?"}: ${await describeNoTrain(plan, eligible, projectId, database)}, ${plan.order.length} ride sequentially`);
  return "sequential";
}

/** The reason half of `pickQueueStrategy`'s log line: the ineligible members, or the opt-in that said no. */
async function describeNoTrain(plan: MergeQueuePlan, eligible: boolean, projectId: string | null, database: Database): Promise<string> {
  const ineligible = plan.order.flatMap((ws) => {
    const reason = trainMemberIneligibility(ws);
    return reason ? [{ workspaceId: ws.id, issueNumber: ws.issueNumber, reason }] : [];
  });
  if (ineligible.length > 0) return formatIneligibleNote(ineligible);
  if (!eligible) {
    const bases = new Set(plan.order.map((ws) => `${ws.repoPath}@${ws.baseBranch}`));
    return `members span ${bases.size} repo/base pair(s) (${[...bases].join(", ")})`;
  }
  if (!projectId) return "project unresolved";
  const optIn = await resolveTrainOptIn(projectId, database);
  return `opt-in false (posture ${optIn.posture.level}, trainMaxSize ${optIn.maxSize}${optIn.fromPosture ? "" : ", explicit"})`;
}

/**
 * Resolve the batch's project and persist its `merge_trains` row BEFORE any git/gate work
 * (#906), so a crash mid-assembly still leaves a row the startup reconciler can find. Returns
 * `null` when the project cannot be resolved — there is then no `verify_script` to gate with,
 * so the caller must fail closed rather than run a train with no gate.
 *
 * #1158: a batch that is ALREADY represented by a live `assembling`/`gating` row — same member
 * set or not — REFUSES here (see the `#1153`/`#1158` comment below) rather than minting a
 * second row or joining the existing one. Without this, every monitor cycle (or reconciler
 * resume) that reached this function for a batch already stuck behind the repo lock
 * (`acquireQueueRepoLock` can wait up to 90 minutes) minted a fresh row before ever reaching the
 * lock wait — a 5-minute cycle over a few hours produced dozens of `assembling` rows all naming
 * the same 5 workspace ids, none of which ever resolved.
 */
async function beginMergeTrain(
  first: { issueId: string },
  memberWorkspaceIds: string[],
  database: Database,
  boardEvents?: BoardEventSink,
): Promise<{ trainId: string; projectId: string; label: string } | null | "already_in_flight"> {
  // The gate is per-PROJECT (it reads verify_script_<projectId>), and WorkspaceQueueInfo
  // carries only issueId — resolve the project the same way computePlan does.
  const issueRows = await getMergeQueueIssueRows([first.issueId], database);
  const projectId = issueRows[0]?.projectId ?? null;
  if (!projectId) return null;

  // #1153: refuse a SECOND train for a project that already has one unfinished
  // (`assembling`/`gating`), same member set or not. This is the seam every caller goes
  // through — the batching-window orchestrator also checks this before releasing
  // (`auto-merge-orchestrator.ts`), but an explicit `strategy: "train"` request via
  // `POST /api/merge-queue` reaches this function directly, so the invariant has to hold here
  // too rather than only upstream.
  //
  // #1158: a SAME-member-set retry must ALSO refuse here rather than join the existing row.
  // `findActiveMergeTrainForMembers` still exists so the STARTUP RECONCILER (the one caller
  // that first abandons the stranded row it is about to resume, in `background-services.ts`)
  // never finds its own now-terminal row and mistakes it for a live duplicate — but for any
  // OTHER caller, joining a still-live row means two independent `runTrainStrategy` generators
  // hold the same `trainId` and each later calls `finishMergeTrain`/`updateMergeTrainState`
  // on it, serialized only by the repo lock: whichever finishes second silently overwrites the
  // first's `gateEvidence`/`bisectResult`, and a lock-timeout abandon from either one can stomp
  // a sibling attempt that is still mid-gate. Refusing (like the differing-member-set case
  // already did) is what actually fixes #1158's duplicate-row bug without opening this race —
  // the batch is picked up again once the one active train finishes.
  const active = await listActiveMergeTrainsForProject(projectId, ["assembling", "gating"], database);
  if (active.length > 0) return "already_in_flight";

  // #1190: `train/<today>-<NN>`, minted from how many this project has already started today —
  // readable in `git log --first-parent` in place of the old `q<base36 timestamp>` scratch
  // label, which explained nothing about which tickets rode together.
  const dateStamp = trainDateStamp();
  const seq = (await countTrainsForProjectOnDate(projectId, dateStamp, database).catch(() => 0)) + 1;
  const label = formatTrainLabel(dateStamp, seq);

  const trainId = randomUUID();
  await createMergeTrain({ id: trainId, projectId, label, memberWorkspaceIds }, database);
  boardEvents?.broadcast(projectId, "merge_train_changed");
  await recordBoardingComments(trainId, label, memberWorkspaceIds, database);
  return { trainId, projectId, label };
}

/**
 * #1181 — the `shouldLand` port for `runMergeTrain`: a fresh read of the row right before
 * landing. Returns the refusal reason when the row was marked `abandoned` while the job ran
 * (operator cancel, or a reconciler verdict on a row this process was still gating), else
 * null. A read failure lands: the row's state is bookkeeping, and refusing to land on an
 * unreadable row would turn a transient DB hiccup into a discarded green gate.
 */
async function vetoLandingIfAbandoned(trainId: string, database: Database): Promise<string | null> {
  const current = await getMergeTrain(trainId, database).catch(() => undefined);
  if (current?.state !== "abandoned") return null;
  return `train row ${trainId} was marked abandoned while the gate ran (${current.reconciledReason ?? "no reason recorded"}) — not landing a train nobody will account for`;
}

/**
 * Persist a train's final state and the evidence a "Merge train" panel/history view reads
 * (#906). Best effort — a bookkeeping failure here must never be reported as the train itself
 * failing; the git-level outcome already happened and is what the caller's events describe.
 */
async function finishMergeTrain(
  trainId: string,
  projectId: string,
  label: string,
  result: Awaited<ReturnType<typeof runMergeTrain>>,
  members: Array<{ workspaceId: string; issueNumber?: number | null }>,
  database: Database,
  review?: MergeTrainGateEvidenceDto["review"],
  boardEvents?: BoardEventSink,
): Promise<void> {
  // #1153: an operator's cancel (POST /trains/:id/cancel) marks the row `abandoned` while this
  // run may still be in flight — there is no cancellation token wired into `runMergeTrain`, so
  // the run itself keeps going, but its eventual result must not overwrite the operator's
  // verdict back to `landed`/`red`. The gate/land work already happened either way; only the
  // BOOKKEEPING is skipped.
  const current = await getMergeTrain(trainId, database).catch(() => undefined);
  if (current?.state === "abandoned") {
    console.log(`[merge-train] ${trainId} finished after being cancelled — leaving it abandoned`);
    return;
  }
  // #1154: a red train whose failure was never attributed to any individual member (an
  // environment failure — see `isEnvironmentFailure` — skips bisect on purpose) used to persist
  // `landed: [], dropped: []` with nothing else, so the evidence named NONE of the members it
  // held for the train's whole life. `unresolved` is every member that is neither landed, nor
  // dropped during assembly, nor individually gate-rejected by a bisect — i.e. every member
  // whose disposition is "the batch failed and this member shares that verdict, unattributed".
  const { gateEvidence, gateRejected } = buildTrainGateEvidence(result, members, review);
  await updateMergeTrainState(trainId, {
    ...finalTrainStateFields(result),
    gateEvidence: { ...gateEvidence },
    bisectResult: gateRejected.length > 0 ? { gateRejected } : null,
    finishedAt: new Date().toISOString(),
  }, database).catch((err) => console.warn(`[merge-train] failed to persist final state for ${trainId} (non-fatal):`, errorMessage(err)));
  boardEvents?.broadcast(projectId, "merge_train_changed");

  // #1188 — one issue comment per member describing what the train did with it. Reuses
  // `insertIssueComment` (the sanctioned single write path) rather than a second mechanism;
  // best-effort per member, and never blocks the bookkeeping above.
  await recordFinishComments(trainId, label, result, members, database);
}

/**
 * Acquire the repo lock and run the gated train, treating a repo-lock timeout and a THROW out
 * of `runMergeTrain` as the same shape of failure: a train job that died before finishing.
 * Both used to be handled differently (see the #1215 call-site comment) — this is the ONE place
 * that decides "the job is doomed" and always leaves the row terminal (`abandoned` or `red`)
 * and the live-train registry cleared before returning, so the caller never has to.
 *
 * Split out of `runTrainStrategy` (rather than inlined as a second `try/catch`) so the
 * generator's own branch count stays under the god-module gate's per-function ceiling (#726) —
 * this function carries both failure paths' branches instead.
 */
async function runDoomedTrainJob(args: {
  database: Database;
  boardEvents: BoardEventSink | undefined;
  reconcileAlreadyMerged: (workspaceId: string) => Promise<unknown>;
  sendTurn: (workspaceId: string, content: string) => Promise<unknown>;
  reviewTrain: typeof runTrainReview;
  repoPath: string;
  baseBranch: string;
  members: TrainReviewMember[];
  label: string;
  trainId: string;
  projectId: string;
  /** Mutable out-param: `afterGreen` below writes the review evidence the caller persists. */
  reviewEvidenceRef: { current: MergeTrainGateEvidenceDto["review"] };
  /**
   * #1203 — the real cancellation token for this job. An operator cancel aborts it, which stops
   * the bisect driver from starting another attempt and kills whatever gate/install child
   * process is currently running.
   */
  abortController: AbortController;
  /** Sends a base-conflict member back to its builder as soon as an assembly drops it. */
  onDropped: OnTrainDropped;
  /** #1277 — runs the in-train fix agent's turns. */
  agentRunner: TrainAgentRunner;
  /** #1463 — flush mode: arch+typecheck gate, no bisect, no fix agent, no train review, tag after landing. */
  flush?: FlushRunSpec;
}): Promise<{ ok: true; result: Awaited<ReturnType<typeof runMergeTrain>>; shepherd?: MergeTrainShepherdDto } | { ok: false; reason: string }> {
  const { database, boardEvents, reconcileAlreadyMerged, sendTurn, reviewTrain, repoPath, baseBranch, members, label, trainId, projectId, reviewEvidenceRef, abortController, onDropped, agentRunner, flush } = args;

  // #1568: held for assembly and landing only — released while a gate runs, like a single
  // workspace's pre-lock gate, so the rest of the queue is not refused for the gate's whole hour.
  const trainLock = createSuspendableRepoLock(() => acquireQueueRepoLock(repoPath, `merge-train:${label}`, {
    timeoutMs: MERGE_TRAIN_REPO_LOCK_TIMEOUT_MS,
    // #1150: a contended wait asks whether the holder is a train job this process still has live.
    checkHolderLiveness: (holder) => { const m = /^merge-train:(.+)$/.exec(holder); return m ? isMergeTrainLabelLive(m[1]) : undefined; },
  }), abortController.signal);
  try {
    await trainLock.acquireInitial();
  } catch (err) {
    const reason = `could not acquire the repo lock within ${Math.round(MERGE_TRAIN_REPO_LOCK_TIMEOUT_MS / 60_000)}m: ${errorMessage(err)}`;
    unregisterLiveMergeTrain(trainId);
    await updateMergeTrainState(trainId, { state: "abandoned", reconciledReason: reason, finishedAt: new Date().toISOString() }, database).catch(() => undefined);
    boardEvents?.broadcast(projectId, "merge_train_changed");
    await cleanupTrainWorktreesForLabel({ database, repoPath, label });
    return { ok: false, reason: `train abandoned: ${reason}` };
  }
  // #1503: the suspendable lock heartbeats while held and frees itself the moment an operator cancels.
  noteMergeTrainGateActivity(trainId, false); // #1513: restart the idle clock now the repo lock is held
  let kit: ReturnType<typeof createTrainShepherdKit> | undefined;
  try {
    // #1277: the project's red-handling policy, read once per train through the preference layer.
    const policy = resolveMergeTrainRedPolicy(toPrefMap(await getAllPreferencesCached(database).catch(() => [])), projectId);
    // #1572: ONE shepherd per train, shared by incremental assembly (conflicts) and the red gate.
    const shepherdKit = kit = createTrainShepherdKit({ database, agentRunner, policy, trainId, projectId, label, members, boardEvents });
    const result = await runMergeTrain({
      repoPath,
      baseBranch,
      members,
      label,
      trainId,
      redStrategy: flush ? undefined : policy.strategy,
      ...(flush ? { bisectOnFailure: false } : {}),
      // #1181: a cancel or reconciler can mark this row `abandoned` mid-gate; such a train must not
      // LAND, so a fresh read is checked right before every landing. #1568: the lock is retaken here too.
      shouldLand: async () => {
        await trainLock.beginLanding();
        return vetoLandingIfAbandoned(trainId, database);
      },
      // #1203: checked by the bisect driver before EVERY attempt (root and every half) — a
      // cancel therefore ends the job after the current gate's child process is killed, at the
      // latest, rather than continuing through the rest of a bisect tree.
      signal: abortController.signal,
      onDropped,
      ...(flush ? {} : { assemble: shepherdKit.assemble }),
      runGate: ({ trainRef, included, label: attemptLabel }) => withMergeTrainGateActivity(trainId, async () => {
        // Gate the TREE THAT LANDS. A per-member gate never tests the merge commit, which is
        // how two individually-green branches can produce a red base with no conflict.
        //
        // #1193: keyed by the ATTEMPT's label (`q1a`, `q1b`), not the train's — two bisect
        // halves may be gating at the same moment, each in its own staging worktree (the
        // leaf is derived from `trainRef`, which already differs per half), and their log
        // lines and synthetic gate ids must tell them apart.
        //
        // #1204: the worktree + setup + `runPreMergeGate` half is `runTrainStagingGate`, so
        // the control arm gates the bare base through the SAME code rather than a second copy.
        //
        // #1203: guarded — a row an operator already cancelled (`abandoned`) or the reconciler
        // already resolved must never be re-marked `gating` by a bisect attempt that started
        // before the cancel and is only now reaching this line. The `signal` check at the top of
        // `landGreenest` is what actually STOPS the next attempt; this guard is the second half —
        // it stops THIS attempt's own bookkeeping from overwriting the operator's verdict while
        // the attempt races to notice the signal.
        await updateMergeTrainState(trainId, { state: "gating", guardStates: ["assembling", "gating"] }, database).catch(() => undefined);
        boardEvents?.broadcast(projectId, "merge_train_changed");
        await trainLock.drop(); // #1568: gate pre-lock
        const gate = await runTrainStagingGate({
          database, repoPath, baseBranch, projectId,
          ref: trainRef,
          attemptLabel,
          includedWorkspaceIds: included.map((m) => m.workspaceId),
          // #1203: same token — a cancel mid-gate kills the running install/verify child process.
          signal: abortController.signal,
          verifyScriptOverride: flush?.gateScript,
          coveredFiles: members.flatMap((m) => (m as { changedFiles?: readonly string[] | null }).changedFiles ?? []),
          onRed: flush ? undefined : buildTrainOnRed({ database, policy, shepherd: shepherdKit.shepherd, label, attemptLabel, baseBranch, included, members, placement: { projectId, repoPath } }),
          afterGreen: async ({ gateWorktree }) => {
            if (flush) return {};
            // #1194: review ONCE, on the tree that just proved green - the assembled diff vs the
            // base, one reviewer, every member's criteria in `{{members}}`. A blocking finding
            // names its member in `sided`; `runMergeTrain` re-lands the rest without it.
            const decision = resolveTrainReviewDecision(toPrefMap(await getAllPreferencesCached(database).catch(() => [])), projectId);
            if (!decision.run) {
              reviewEvidenceRef.current ??= { status: "skipped", reason: decision.reason };
              return {};
            }
            const reviewMembers: TrainReviewMember[] = included.flatMap((m) => {
              const full = members.find((x) => x.workspaceId === m.workspaceId);
              return full ? [{ workspaceId: full.workspaceId, branch: full.branch, issueId: full.issueId, issueNumber: full.issueNumber ?? null, changedFiles: full.changedFiles }] : [];
            });
            // #1192: `repoPath` + `sendTurn` are what a sided member's siding record needs — the
            // same row, tag and sha-keyed hold a conflict drop gets (`partitionSidedMembers`
            // above then withholds it from the next window until its tip moves).
            const review = await reviewTrain({
              projectId, trainLabel: label, trainRef, baseBranch, gateWorktree, repoPath,
              members: reviewMembers, blocking: decision.blocking, thorough: decision.thorough,
            }, { database, sendTurn });
            reviewEvidenceRef.current ??= review.evidence;
            return { sided: review.sided };
          },
        });
        if (!gate.passed && gate.inconclusive) {
          console.log(`[merge-train] ${describeInconclusiveGate(label, attemptLabel, gate.message)}`);
        } else if (!gate.passed) {
          // Name the red: train, members, stage and suite(s), for the whole train and each half.
          const gatedMembers = included.map((m) => members.find((x) => x.workspaceId === m.workspaceId) ?? { workspaceId: m.workspaceId });
          console.log(`[merge-train] ${describeTrainGateRed({ label, attemptLabel, members: gatedMembers, stage: gate.stage, failedSuites: gate.failedSuites, guardFailure: gate.guardFailure, message: gate.message })}`);
        }
        return gate;
      }),
      // #1204 — the CONTROL ARM, asked once before a red full train is halved: is the BARE
      // BASE red? If it is, the failure belongs to master and no member may be blamed for it.
      gateBaseAlone: () => withMergeTrainGateActivity(trainId, async () => { await trainLock.drop(); return gateBaseAloneOnce({ database, repoPath, baseBranch, projectId, trainLabel: label }); }),
      closeMember: async (workspaceId) => {
        // Reuse the sanctioned already-merged path rather than reimplementing the
        // mergedAt/status/comment bookkeeping the reconcilers depend on.
        await reconcileAlreadyMerged(workspaceId);
        // #1192: a member that lands has nothing left to be sided about — drop any leftover
        // record from an earlier drop-then-rebase cycle rather than leaving a stale row.
        const landedMember = members.find((m) => m.workspaceId === workspaceId);
        if (landedMember) await clearTrainSiding(landedMember, { database, sendTurn });
      },
      // #1154: a missing-module gate failure is the staging worktree's environment, not any
      // member's code — bisecting it burns gate runs (observed: 9 runs, 3h23m, nothing
      // landed) to reach the same verdict every time, and risks blaming an arbitrary member.
      // Reuses the same signature the gate's own #169 install-retry already matches against.
      isEnvironmentFailure: looksLikeMissingDepsFailure,
      // #1189: persist each bisect node as it finishes, so the row shows partial progress
      // while the train is still gating. Evidence column only — never the state (#1153).
      // The broadcast lets the Delivery chip flip to "Bisecting" as soon as a red node lands.
      onAttempt: async (attempt) => {
        await appendMergeTrainAttempt(trainId, { ...attempt }, database);
        boardEvents?.broadcast(projectId, "merge_train_changed");
        await trainLock.endLanding(); // #1568: the attempt is done landing (or never did)
      },
    });
    if (flush) await finishFlushRun(flush, repoPath, label, result).catch((e) => console.warn(`[merge-train] ${label}: flush finish failed: ${errorMessage(e)}`));
    return { ok: true, result, ...(shepherdKit.finalStatus() ? { shepherd: shepherdKit.finalStatus() } : {}) };
  } catch (err) {
    const reason = errorMessage(err);
    await updateMergeTrainState(trainId, { state: "red", reconciledReason: reason, finishedAt: new Date().toISOString() }, database).catch(() => undefined);
    unregisterLiveMergeTrain(trainId);
    boardEvents?.broadcast(projectId, "merge_train_changed");
    // #1621: the teardown below deletes the train branches; keep the shepherd's commits reachable.
    const pins = await pinTrainRefsForLabel({ repoPath, label });
    return { ok: false, reason: `train orchestrator threw: ${reason}${pins.length > 0 ? ` (train kept at ${pins.join(", ")})` : ""}` };
  } finally {
    await kit?.flush(); // #1572: no live shepherd write may land after the train's final evidence write
    // #1568: retake the lock for the teardown; a timeout here only skips it (reconcilers are the backstop).
    await trainLock.ensureHeld().catch(() => undefined);
    // #1235: the train's own teardown on BOTH exits — every attempt's worktree and `kanban/train/<label>*`
    // branch (a leftover worktree blocks the branch delete; a killed gate leaves both). Never throws.
    await cleanupTrainWorktreesForLabel({ database, repoPath, label });
    await trainLock.close();
  }
}

/**
 * Build the train-strategy runner for `createMergeQueueService`. `reconcileAlreadyMerged` is
 * injected rather than importing `workspace-merge.service.ts` directly here, so this module
 * doesn't need its own copy of that service's construction — the caller already built one.
 */
export function createMergeTrainRunner(deps: {
  database: Database;
  reconcileAlreadyMerged: (workspaceId: string) => Promise<unknown>;
  /**
   * #1194 - the train-scoped reviewer, run inside the gate worktree after a green gate. Injected
   * so the dispatch tests can stand in a canned verdict instead of spawning an agent; the
   * default is the real one-shot review.
   */
  reviewTrain?: typeof runTrainReview;
  /** #1192 — the port a siding drop nudges through. 409-safe: a busy agent is not an error. */
  sendTurn: (workspaceId: string, content: string) => Promise<unknown>;
  /**
   * #1210 — is there a live session to receive that `/turn`? Defaults to the real check
   * (`merge-train-siding.service.ts`'s own default) when omitted.
   */
  hasLiveSession?: (workspaceId: string) => Promise<boolean>;
  /**
   * #1277 — one fix-agent turn in a train worktree. Injected so tests stand in a canned agent;
   * the default is the board's one-shot provider path (`createOneShotAgentRunner`).
   */
  agentFixRunner?: TrainAgentRunner;
  /**
   * Relaunches a base-conflict member's builder with the send-back prompt when its agent is gone
   * (`merge-train-siding.service.ts`: why a builder relaunch, not resolve-conflicts).
   */
  relaunch?: (workspaceId: string, prompt: string) => Promise<unknown>;
  /** #1186 — broadcasts `merge_train_changed` at every `merge_trains` row state write, so a
   * departure-board "live train" panel does not need to poll. */
  boardEvents?: BoardEventSink;
}) {
  const { database, reconcileAlreadyMerged, sendTurn, hasLiveSession, relaunch, boardEvents } = deps;
  const reviewTrain = deps.reviewTrain ?? runTrainReview;
  const agentRunner = deps.agentFixRunner ?? createPlacedSessionRunner({ database });

  /**
   * Run the whole batch as one release train: assemble → gate ONCE → land → close each member.
   *
   * The gate needs a worktree whose tree IS the assembled train (not any member's branch), so
   * one is created at the train ref, gated, and removed. That worktree is the only reason this
   * lives here rather than in merge-train.service.ts — the service stays free of worktree and
   * DB concerns so its logic can be tested without either.
   *
   * The whole run holds the repo lock: the train's value depends on its base not moving
   * between assembly and landing, and `landMergeTrain` refuses (correctly) if it does.
   */
  async function* runTrainStrategy(plan: MergeQueuePlan, flush?: FlushRunSpec): AsyncGenerator<MergeQueueEvent> {
    const repoPath = plan.order[0].repoPath;
    const baseBranch = plan.order[0].baseBranch as string;
    // #1190: the label is minted by `beginMergeTrain` (`train/<today>-<NN>`), not here.
    const allMembers = plan.order.map((ws) => ({
      workspaceId: ws.id,
      branch: ws.branch as string,
      issueNumber: ws.issueNumber,
      // #1194: what the train review needs to attach a finding to the right ticket.
      issueId: ws.issueId,
      changedFiles: ws.changedFiles,
    }));
    // #1194: what the train review did on the first green gate, for the persisted evidence.
    let reviewEvidence: MergeTrainGateEvidenceDto["review"];

    // #1192: hold back any member still on a siding from a prior drop — its branch tip has
    // not moved since it was asked to rebase, so re-assembling it would just reproduce the
    // same conflict. Re-admission (the tip moving) is checked and cleared as a side effect.
    const { admitted, held } = await partitionSidedMembers(allMembers, repoPath, { database, sendTurn, probeBaseConflict: baseConflictProbe(baseBranch) });
    for (const h of held) {
      yield {
        type: "skipped",
        workspaceId: h.member.workspaceId,
        issueNumber: h.member.issueNumber ?? null,
        issueTitle: "",
        reason: `train siding: ${h.reason}`,
      };
    }
    if (admitted.length === 0) {
      yield { type: "done", merged: [], failed: [], skipped: held.map((h) => h.member.workspaceId) };
      return;
    }
    let members = admitted;
    // #1679: a train abandoned for gate age must not be re-gated identically - split or escalate.
    {
      const firstIssue = (plan.order.find((ws) => ws.id === members[0].workspaceId) ?? plan.order[0]);
      const issueRows = await getMergeQueueIssueRows([firstIssue.issueId], database);
      const pid = issueRows[0]?.projectId;
      const recent = pid ? await listRecentMergeTrainsForProject(pid, 5, database).catch(() => []) : [];
      const split = decideAgeAbandonSplit(members.map((m) => m.workspaceId), recent, pid ?? undefined);
      if (split.action === "escalate") {
        console.warn(`[merge-train] ${split.reason}`);
        yield { type: "skipped", workspaceId: firstIssue.id, issueNumber: firstIssue.issueNumber, issueTitle: firstIssue.issueTitle, reason: split.reason };
        yield { type: "done", merged: [], failed: [], skipped: members.map((m) => m.workspaceId) };
        return;
      }
      if (split.action === "split") {
        console.log(`[merge-train] ${split.reason}`);
        const deferred = new Set(split.deferred);
        for (const m of members.filter((x) => deferred.has(x.workspaceId))) {
          yield { type: "skipped", workspaceId: m.workspaceId, issueNumber: m.issueNumber ?? null, issueTitle: "", reason: split.reason };
        }
        members = members.filter((x) => !deferred.has(x.workspaceId));
      }
    }
    // A member that conflicts with the base is sent back to its builder the moment assembly
    // drops it (`onDropped` inside the train), not after the whole gate and bisect: observed
    // live (#1253/#1261), a drop recorded only at the end never reached the builder when the
    // train job outlived the window or died, and the next train dropped the same member again.
    const sendBack = createTrainDropSendBack({ members, baseBranch, repoPath, deps: { database, sendTurn, hasLiveSession, relaunch } });
    const first = plan.order.find((ws) => ws.id === members[0].workspaceId) ?? plan.order[0];

    const trainStart = await beginMergeTrain(first, members.map((m) => m.workspaceId), database, boardEvents);
    if (trainStart === "already_in_flight") {
      // #1153: never assemble a second train while one is already unfinished — that is exactly
      // what turned a queue into a livelock (each new train contends for the repo lock the
      // first is holding). Leave these members as-is; the next window release (or an operator
      // retry) picks them up once the in-flight train finishes.
      yield { type: "skipped", workspaceId: first.id, issueNumber: first.issueNumber, issueTitle: first.issueTitle, reason: "a merge train is already in flight for this project — not assembling a second one" };
      yield { type: "done", merged: [], failed: [], skipped: members.map((m) => m.workspaceId) };
      return;
    }
    if (!trainStart) {
      // Fail closed rather than gate-less: without a project there is no verify_script to run,
      // and a train that skips the gate is exactly what this feature must never become.
      yield { type: "error", workspaceId: first.id, issueNumber: first.issueNumber, issueTitle: first.issueTitle, error: "train aborted: could not resolve the project for the batch, so the gate could not be run" };
      yield { type: "done", merged: [], failed: members.map((m) => m.workspaceId), skipped: [] };
      return;
    }
    const { trainId, projectId, label } = trainStart;
    // #1181: from here until `finishMergeTrain` this row has a live job in THIS process. The
    // reconciler's periodic sweep reads the registry and leaves registered rows alone; without
    // it the sweep applied its boot-time "nothing can be live" rule to a train mid-gate.
    // #1203: the returned controller is this job's real cancellation token — an operator cancel
    // aborts it, which stops the bisect driver from starting another attempt and kills whatever
    // gate/install child process is currently running.
    const abortController = registerLiveMergeTrain({ trainId, label, projectId });

    // #1153: bounded shorter than the per-workspace queue's 90-minute budget — a train that
    // cannot get the lock within this window is ABANDONED (not left polling), since re-assembly
    // is cheap and a livelock is exactly nine 90-minute waiters queued behind one holder that
    // itself can never catch up. Combined with `beginMergeTrain` now refusing a second train
    // while one is already in flight (below), this is the only wait a train ever takes.
    //
    // #1215: a repo-lock timeout and a THROW out of `runMergeTrain` (the ancestry invariant, or
    // "base moved after gating") are both "this train job died before finishing" — and used to
    // be handled inconsistently: the lock timeout finished the row `abandoned` and reported it,
    // while a throw from `runMergeTrain` had no handler at all, only a `finally` that released
    // the lock. The row was left `gating` forever: `finishMergeTrain`/`unregisterLiveMergeTrain`
    // never ran, the in-process registry still listed the train as live, the reconciler skipped
    // it as "live in this process", and every later `beginMergeTrain` for this project refused
    // with "already in flight" — a queue dead until the process restarted. `runDoomedTrainJob`
    // now owns both failure shapes and always finishes the row terminal before returning.
    const reviewEvidenceRef: { current: MergeTrainGateEvidenceDto["review"] } = { current: reviewEvidence };
    const outcome = await runDoomedTrainJob({
      database, boardEvents, reconcileAlreadyMerged, sendTurn, reviewTrain,
      repoPath, baseBranch, members, label, trainId, projectId,
      reviewEvidenceRef,
      abortController,
      onDropped: sendBack.onDropped,
      agentRunner,
      flush,
    });
    reviewEvidence = reviewEvidenceRef.current;
    if (!outcome.ok) {
      yield { type: "error", workspaceId: first.id, issueNumber: first.issueNumber, issueTitle: first.issueTitle, error: outcome.reason };
      yield { type: "done", merged: [], failed: members.map((m) => m.workspaceId), skipped: [] };
      return;
    }
    const result = outcome.result;

    try {
      await finishMergeTrain(trainId, projectId, label, result, members, database, reviewEvidence, boardEvents);
      // #1572: finishing rewrote the evidence; put the shepherd's final status (session, turns, conflicts) back.
      if (outcome.shepherd) await recordMergeTrainShepherd(trainId, { ...outcome.shepherd }, database).catch(() => undefined);
    } finally {
      // #1181: the row's terminal state is persisted (or deliberately left `abandoned`) — only
      // now may a sweep treat it as it finds it. Idempotent with the lock-failure clear above.
      unregisterLiveMergeTrain(trainId);
    }

    await sendTrainRedFeedback(result, members, { sendTurn, headSha: (branch) => gitService.revParse(repoPath, branch) });
    logTrainConflictClusters(label, result);

    // #1184: one event per member — a bisect re-drops a base-conflicting member in every
    // sub-attempt that contains it, and the queue must not hear "skipped" N times for one ticket.
    const seenEvent = new Set<string>();
    if (result.dropped.length > 0) {
      // #1192: the sha a conflicting member was dropped against, for the /turn message and the
      // ticket comment. `result.mergeSha` (what actually landed) is the truest "train tip" when
      // something did land; otherwise fall back to the base as it stood for this run — best
      // effort, since naming the exact sha is for a human/agent reading the message, not a
      // correctness dependency of the siding mechanism itself (which keys on the MEMBER's own
      // branch tip, not this one).
      const trainTipSha = result.mergeSha ?? (await gitService.revParse(repoPath, baseBranch).catch(() => baseBranch));
      // Most base-conflict drops were already sent back the moment assembly dropped them
      // (`onDropped`); this catches the rest (a re-assembly after a base move or a siding).
      // `deferred` drops (#1191, member-vs-member) are never sent back.
      await sendBack.onDropped(result.dropped, { trainRef: result.trainRef, tipSha: trainTipSha });
    }
    for (const d of result.dropped) {
      if (seenEvent.has(d.member.workspaceId)) continue;
      seenEvent.add(d.member.workspaceId);
      yield { type: "skipped", workspaceId: d.member.workspaceId, issueNumber: d.member.issueNumber ?? null, issueTitle: "", reason: `dropped from train: ${d.reason.slice(0, 200)}` };
    }
    // #492 — a member the bisect individually proved red is attributed to ITSELF, not blamed
    // on the batch. This is the difference between "your branch broke the gate" and "someone
    // in a batch you were in broke the gate", and only the first is actionable by its author.
    for (const r of result.gateRejected) {
      if (seenEvent.has(r.member.workspaceId)) continue;
      seenEvent.add(r.member.workspaceId);
      yield { type: "error", workspaceId: r.member.workspaceId, issueNumber: r.member.issueNumber ?? null, issueTitle: "", error: `${BRANCH_ALONE_FAILURE_PREFIX} (bisected out of the train): ${r.reason.slice(0, 300)}` };
    }
    // #1194 - a member the train review sided did NOT land, but its train did (or would have):
    // the findings are already on its ticket, and its branch is untouched. `skipped`, like a
    // conflict drop: this is the author's to fix and re-push, not a batch failure.
    for (const sd of result.sided) {
      if (seenEvent.has(sd.member.workspaceId)) continue;
      seenEvent.add(sd.member.workspaceId);
      yield { type: "skipped", workspaceId: sd.member.workspaceId, issueNumber: sd.member.issueNumber ?? null, issueTitle: "", reason: `sided by the train review: ${sd.reason.slice(0, 300)}` };
    }
    if (result.landed.length === 0 && result.inconclusive) {
      yield* inconclusiveSkipEvents(members, seenEvent, result.gateFailure);
      yield { type: "done", merged: [], failed: [], skipped: members.map((m) => m.workspaceId) };
      return;
    }
    if (result.landed.length === 0) {
      for (const m of members) {
        if (result.dropped.some((d) => d.member.workspaceId === m.workspaceId)) continue;
        if (result.gateRejected.some((r) => r.member.workspaceId === m.workspaceId)) continue;
        if (result.sided.some((sd) => sd.member.workspaceId === m.workspaceId)) continue;
        yield { type: "error", workspaceId: m.workspaceId, issueNumber: m.issueNumber ?? null, issueTitle: "", error: `train gate failed — nothing landed: ${(result.gateFailure ?? "").slice(0, 300)}` };
      }
      const sidedIds = new Set(result.sided.map((sd) => sd.member.workspaceId));
      yield { type: "done", merged: [], failed: members.filter((m) => !sidedIds.has(m.workspaceId)).map((m) => m.workspaceId), skipped: [...sidedIds] };
      return;
    }
    console.log(`[merge-train] ${label}: ${result.landed.length}/${members.length} landed in ${result.gateRuns} gate run(s)` +
      `${result.heldBack ? `, ${result.heldBack.summary}` : result.gateRejected.length > 0 ? `, ${result.gateRejected.length} bisected out` : ""}` +
      `${result.sided.length > 0 ? `, ${result.sided.length} sided by the train review` : ""}`);
    for (const m of result.landed) {
      const closeFailure = result.closeFailures.find((c) => c.member.workspaceId === m.workspaceId);
      // A close-out failure is NOT a merge failure — the work IS on the base branch, only the
      // bookkeeping lags, and the existing reconcilers recover that. Log it rather than
      // emitting `error`, which callers treat as "this ticket did not land".
      if (closeFailure) {
        console.warn(`[merge-train] ${m.branch} landed via train ${result.mergeSha?.slice(0, 8)} but close-out lagged: ${closeFailure.reason.slice(0, 200)}`);
      }
      yield { type: "merged", workspaceId: m.workspaceId, issueNumber: m.issueNumber ?? null, issueTitle: "" };
    }
    yield {
      type: "done",
      merged: result.landed.map((m) => m.workspaceId),
      // A bisected-out member did NOT land, so reporting it as anything but failed would tell
      // the queue its work is on the base when it is not.
      failed: result.gateRejected.map((r) => r.member.workspaceId),
      skipped: [...result.dropped.map((d) => d.member.workspaceId), ...result.sided.map((sd) => sd.member.workspaceId)],
    };
  }

  return { runTrainStrategy };
}
