/**
 * Release-train strategy for the merge queue (#904, #906) — split out of
 * `merge-queue.service.ts` (arch-review god-module gate, #906 fix-and-merge) once the
 * train-persistence work (`beginMergeTrain`/`finishMergeTrain`) pushed that file past the
 * 1000-line hard ceiling. This module owns everything specific to running ONE batch as a
 * release train; `createMergeQueueService` calls `createMergeTrainRunner` and dispatches to
 * it when `trainEligible` + the caller/classifier/pref opt in.
 */
import type { Database } from "../db/index.js";
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
  updateMergeTrainState,
} from "../repositories/merge-train.repository.js";
import { runMergeTrain, formatTrainLabel, trainDateStamp, trainRefName } from "./merge-train.service.js";
import { registerLiveMergeTrain, unregisterLiveMergeTrain } from "./merge-train-live-registry.js";
import { runPreMergeGate, looksLikeMissingDepsFailure } from "./pre-merge-gate.service.js";
import { resolveWorktreeClaims, removeWorktreeUnlessShared } from "@agentic-kanban/shared/lib/worktree-claim";
import { randomUUID } from "node:crypto";
import { acquireQueueRepoLock, MERGE_TRAIN_REPO_LOCK_TIMEOUT_MS } from "./merge-queue-repo-lock.js";
import type { MergeQueueEvent, MergeQueuePlan } from "./merge-queue.service.js";
import type { MergeTrainAttemptDto, MergeTrainBaseVerdict, MergeTrainGateEvidenceDto } from "@agentic-kanban/shared/types";
import { getBaseBranchHealthForSha, isBaseHealthAnswer } from "../repositories/base-branch-health.repository.js";
import { getProjectSetupScript } from "../repositories/stack-profile.repository.js";
import { DEFAULT_SETUP_SCRIPT_TIMEOUT_MS, runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import { noteMergeGatePhase } from "./merge-job.service.js";
import { formatIneligibleNote, trainMemberIneligibility } from "./merge-release-partition.js";
import { resolveTrainReviewDecision, runTrainReview, type TrainReviewMember } from "./merge-train-review.service.js";
import { clearTrainSiding, isSidingDrop, partitionSidedMembers, recordTrainSidingDrop } from "./merge-train-siding.service.js";

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
  result: Awaited<ReturnType<typeof runMergeTrain>>,
  members: Array<{ workspaceId: string }>,
  database: Database,
  review?: MergeTrainGateEvidenceDto["review"],
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
    state: result.landed.length > 0 ? "landed" : "red",
    gateEvidence: { ...gateEvidence },
    bisectResult: gateRejected.length > 0 ? { gateRejected } : null,
    finishedAt: new Date().toISOString(),
  }, database).catch((err) => console.warn(`[merge-train] failed to persist final state for ${trainId} (non-fatal):`, errorMessage(err)));
}

/**
 * One entry per workspace id, first reason wins (#1184). A bisect re-assembles every
 * sub-attempt from scratch against the base, so a member that conflicts with the BASE is
 * re-dropped by every attempt that contains it — train qmu4t981a persisted 17 drops for 13
 * members, and the panel's red-debt (dropped minus landed) was wrong in sign and size. The
 * first reason is kept because it is the top-level attempt's, recorded against the full batch.
 */
function uniqueByWorkspace<T extends { member: { workspaceId: string }; reason: string; deferred?: true }>(
  entries: T[],
): Array<{ workspaceId: string; reason: string; deferred?: true }> {
  const seen = new Set<string>();
  const out: Array<{ workspaceId: string; reason: string; deferred?: true }> = [];
  for (const e of entries) {
    if (seen.has(e.member.workspaceId)) continue;
    seen.add(e.member.workspaceId);
    // #1197: a `deferred` (member-vs-member, #1191) drop keeps its mark on the wire, so the
    // panel can say "waits for the next train" instead of showing a bare conflict reason.
    out.push({ workspaceId: e.member.workspaceId, reason: e.reason, ...(e.deferred ? { deferred: true as const } : {}) });
  }
  return out;
}

/**
 * The persisted evidence for a finished train (#906, #1154, #1184), as a pure function of the
 * run result so the shape is testable without a DB. `gateRejected` is returned beside the
 * evidence because it is persisted in its own column (`bisectResult`), not inside it.
 */
export function buildTrainGateEvidence(
  result: Awaited<ReturnType<typeof runMergeTrain>>,
  members: Array<{ workspaceId: string }>,
  review?: MergeTrainGateEvidenceDto["review"],
): { gateEvidence: MergeTrainGateEvidenceDto; gateRejected: Array<{ workspaceId: string; reason: string }> } {
  const dropped = uniqueByWorkspace(result.dropped);
  const gateRejected = uniqueByWorkspace(result.gateRejected);
  // #1194: a member the train review sided is attributed (to its own ticket), not unresolved.
  const sided = uniqueByWorkspace(result.sided);
  const landed = result.landed.map((m) => m.workspaceId);
  const accounted = new Set([
    ...landed,
    ...dropped.map((d) => d.workspaceId),
    ...gateRejected.map((r) => r.workspaceId),
    ...sided.map((sd) => sd.workspaceId),
  ]);
  const unresolved = members.filter((m) => !accounted.has(m.workspaceId)).map((m) => m.workspaceId);
  const { attempts, concurrentGateSavedMs } = annotateConcurrentGates(result.attempts);
  return {
    gateEvidence: {
      gateRuns: result.gateRuns,
      gateFailure: result.gateFailure ?? null,
      landed,
      dropped,
      mergeSha: result.mergeSha ?? null,
      ...(unresolved.length > 0 ? { unresolved } : {}),
      memberCount: members.length,
      landedCount: landed.length,
      uniqueDroppedCount: dropped.length,
      gateRejectedCount: gateRejected.length,
      ...(sided.length > 0 ? { sided, sidedCount: sided.length } : {}),
      ...(review ? { review } : {}),
      // #1189: the complete bisect tree, replacing the live appends made as each node finished.
      // #1193: each node now names the siblings it gated concurrently with.
      attempts,
      concurrentGateSavedMs,
      // #1191: member-vs-member conflict clusters, the input to `group-scan` mode `train-conflicts`.
      ...(result.conflictClusters && result.conflictClusters.length > 0
        ? { conflictClusters: result.conflictClusters.map((c) => ({ workspaceIds: [...c.workspaceIds] })) }
        : {}),
      // #1204: the control arm's verdict on the bare base, so the panel can render "base red,
      // nothing attributable to members" instead of an unexplained red train with no rejections.
      ...(result.baseVerdict ? { baseVerdict: result.baseVerdict } : {}),
    },
    gateRejected,
  };
}

/**
 * #1193 — make the saving from concurrent bisect halves VISIBLE in the persisted tree: mark
 * every node with the labels of the other nodes whose gate window overlapped its own, and
 * total the wall-clock saved (sum of gate durations minus the union of their windows). A tree
 * whose gates all ran one after another gets no `concurrentWith` and a saving of 0 — so a
 * reader of train qmu4t981a's successor can tell at a glance whether the second slot was used.
 *
 * Pure and computed here rather than inside `runMergeTrain` because the overlap of two halves
 * is only known once BOTH have finished, and the live `onAttempt` append happens as EACH one
 * does — the final evidence write is the first moment the whole tree is in hand.
 */
export function annotateConcurrentGates(
  attempts: MergeTrainAttemptDto[],
): { attempts: MergeTrainAttemptDto[]; concurrentGateSavedMs: number } {
  const windows = attempts.map((a) => {
    const start = a.gateStartedAt ? Date.parse(a.gateStartedAt) : NaN;
    const end = a.gateFinishedAt ? Date.parse(a.gateFinishedAt) : NaN;
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? { start, end } : null;
  });
  const annotated = attempts.map((a, i) => {
    const w = windows[i];
    if (!w) return a;
    const concurrentWith = attempts
      .filter((_, j) => {
        const o = windows[j];
        // Strict overlap: a gate that starts the instant another ends was sequential.
        return j !== i && o !== null && o.start < w.end && w.start < o.end;
      })
      .map((b) => b.label);
    return concurrentWith.length > 0 ? { ...a, concurrentWith } : a;
  });
  // Sum of durations minus the union of the windows — the time a sequential run would have
  // spent that this one did not.
  const sorted = windows.filter((w): w is { start: number; end: number } => w !== null).sort((x, y) => x.start - y.start);
  let sum = 0;
  let union = 0;
  let cursorEnd = -Infinity;
  for (const w of sorted) {
    sum += w.end - w.start;
    if (w.start >= cursorEnd) {
      union += w.end - w.start;
      cursorEnd = w.end;
    } else if (w.end > cursorEnd) {
      union += w.end - cursorEnd;
      cursorEnd = w.end;
    }
  }
  return { attempts: annotated, concurrentGateSavedMs: Math.max(0, sum - union) };
}

/**
 * ONE staging gate: a fresh worktree at `ref`, the project's setup script run against it the way
 * a real workspace's is, then `runPreMergeGate`. Extracted to module scope (#1204) because the
 * CONTROL ARM needs exactly this against the BARE BASE, and a second copy of a gate is the last
 * thing this area needs - the train's own `runGate` is now a thin wrapper around it plus the
 * train-scoped review.
 *
 * `afterGreen` runs INSIDE the worktree's lifetime, before teardown, and is where the review
 * lives; a control-arm gate passes none. Fails CLOSED on a throw: a gate we could not run is not
 * a gate that passed.
 */
async function runTrainStagingGate(args: {
  database: Database;
  repoPath: string;
  baseBranch: string;
  projectId: string;
  ref: string;
  attemptLabel: string;
  /** The REAL workspaces whose deferred installs this gate must clear; empty for a control arm. */
  includedWorkspaceIds: string[];
  afterGreen?: (ctx: { gateWorktree: string; gateMessage: string }) => Promise<{ sided?: Array<{ workspaceId: string; reason: string }> }>;
}): Promise<{ passed: boolean; message: string; sided?: Array<{ workspaceId: string; reason: string }> }> {
  const { database, repoPath, baseBranch, projectId, ref, attemptLabel } = args;
  let gateWorktree: string | null = null;
  try {
    // #713: DB-backed claim guard alongside the namespace - the train leaf lives
    // under the same `.worktrees` root as every live workspace's.
    gateWorktree = await gitService.createWorktree(repoPath, ref, undefined, {
      pathNamespace: "train",
      ...(await resolveWorktreeClaims(database, { label: "merge-train-gate" })),
    });
    // #1154: a builder's worktree gets the project's setup/install script run against
    // it before anything else touches it (`workspace-provision.service.ts`); this
    // staging worktree is created fresh by `createWorktree` above with none of that -
    // so on a project whose dependencies are per-worktree (install-per-worktree, not a
    // symlink into main) the train verified a tree that was never actually installed.
    // Provision it the same way a real workspace is, best-effort: a setup failure here
    // is reported through the gate result below rather than thrown, since a project with
    // no setup script configured (installMode "symlink", or none at all) must still gate
    // normally.
    const setupScript = await getProjectSetupScript(projectId, database).catch(() => null);
    if (setupScript && setupScript.trim()) {
      noteMergeGatePhase(`train:${attemptLabel}`, "install", setupScript);
      const setup = await runSetupScript(gateWorktree, setupScript, {
        timeoutMs: DEFAULT_SETUP_SCRIPT_TIMEOUT_MS,
      }).catch((err) => ({ exitCode: 1, stdout: "", stderr: errorMessage(err), timedOut: false }));
      if (setup.exitCode !== 0 && !setup.timedOut) {
        return {
          passed: false,
          message:
            `train staging worktree setup failed (exit ${setup.exitCode}) before the gate could run - ` +
            `dependencies were never installed for this tree, so the gate could not verify anything: ` +
            `${(setup.stderr || setup.stdout || "no output").slice(0, 500)}`,
        };
      }
    }
    // `memberWorkspaceIds`: the synthetic `train:<label>` id matches no `repos` row, so
    // without it the #628 deferred-install check passes vacuously for the whole train.
    const gate = await runPreMergeGate(
      {
        id: `train:${attemptLabel}`,
        workingDir: gateWorktree,
        baseBranch,
        // The INCLUDED members (#676) - a member dropped during assembly is not in this
        // tree, so its outstanding install must not withhold the train.
        memberWorkspaceIds: args.includedWorkspaceIds,
      },
      projectId,
      database,
    );
    if (!gate.passed) return { passed: false, message: gate.message };
    const extra = await args.afterGreen?.({ gateWorktree, gateMessage: gate.message });
    return { passed: true, message: gate.message, ...(extra?.sided && extra.sided.length > 0 ? { sided: extra.sided } : {}) };
  } catch (err) {
    // Fail CLOSED: a gate we could not run is not a gate that passed.
    return { passed: false, message: `train gate could not run: ${errorMessage(err)}` };
  } finally {
    // Route the teardown through the #394 co-residency guard rather than deleting
    // outright: this leaf lives under the same `.worktrees` root as every live
    // workspace's, and it was created WITH a claim above - so the claim is exactly
    // what must be consulted before removing it. Enforced by
    // `worktree-delete-guard-ratchet`.
    if (gateWorktree) {
      const dir = gateWorktree;
      await removeWorktreeUnlessShared({
        database,
        workingDir: dir,
        label: "merge-train-gate",
        removeWorktree: () => gitService.removeWorktree(repoPath, dir),
      }).catch(() => undefined);
    }
  }
}

/**
 * The CONTROL ARM (#1204): what does the gate say about the BARE BASE the train was assembled on?
 *
 * Asked once, by `runMergeTrain`, when the FULL train has failed and is about to be halved. A
 * base-health row recorded at that EXACT sha describes this very tree, so it answers for free;
 * otherwise one staging gate runs on a scratch ref at the base sha, with no member aboard.
 *
 * MEASURED motivation: train/2026-09-19-02 bisected a red master 27 times and marked all 14
 * members `gateRejected`. One run at the top of the search answers the question for the whole
 * tree, so 26 of those 27 were avoidable and none of the 14 attributions was true.
 *
 * Returns null when the question could not be asked at all (the base sha would not resolve, the
 * scratch ref could not be minted) - the bisect then proceeds exactly as it did before #1204,
 * rather than a failed probe becoming a verdict about anybody's code.
 */
async function gateBaseAloneOnce(args: {
  database: Database;
  repoPath: string;
  baseBranch: string;
  projectId: string;
  trainLabel: string;
}): Promise<{ verdict: MergeTrainBaseVerdict; gateRuns: number } | null> {
  const { database, repoPath, baseBranch, projectId, trainLabel } = args;
  const baseSha = await gitService.revParse(repoPath, baseBranch).catch(() => null);
  if (!baseSha) return null;

  const recorded = await getBaseBranchHealthForSha(projectId, baseSha, database).catch(() => null);
  if (recorded && isBaseHealthAnswer(recorded.outcome)) {
    console.log(`[merge-train] ${trainLabel}: control arm answered from base_branch_health at ${baseSha.slice(0, 8)} - base is ${recorded.outcome}, no extra gate run`);
    return { verdict: recorded.outcome === "green" ? "green" : "red", gateRuns: 0 };
  }

  const controlRef = trainRefName(`${trainLabel}-base`);
  try {
    await gitExecOrThrow(["branch", "-f", controlRef, baseSha], { cwd: repoPath });
  } catch (err) {
    console.warn(`[merge-train] ${trainLabel}: control arm could not mint its scratch ref (non-fatal, the bisect proceeds): ${errorMessage(err)}`);
    return null;
  }
  try {
    const gate = await runTrainStagingGate({
      database, repoPath, baseBranch, projectId,
      ref: controlRef,
      attemptLabel: `${trainLabel}-base`,
      includedWorkspaceIds: [],
    });
    console.log(`[merge-train] ${trainLabel}: control arm gated the bare base at ${baseSha.slice(0, 8)} - ${gate.passed ? "green" : "RED"}${gate.passed ? "" : `: ${gate.message.slice(0, 200)}`}`);
    return { verdict: gate.passed ? "green" : "red", gateRuns: 1 };
  } finally {
    await gitExecOrThrow(["branch", "-D", controlRef], { cwd: repoPath }).catch(() => undefined);
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
}) {
  const { database, reconcileAlreadyMerged, sendTurn } = deps;
  const reviewTrain = deps.reviewTrain ?? runTrainReview;

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
  async function* runTrainStrategy(plan: MergeQueuePlan): AsyncGenerator<MergeQueueEvent> {
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
    const { admitted, held } = await partitionSidedMembers(allMembers, repoPath, { database, sendTurn });
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
    const members = admitted;
    const first = plan.order.find((ws) => ws.id === members[0].workspaceId) ?? plan.order[0];

    const trainStart = await beginMergeTrain(first, members.map((m) => m.workspaceId), database);
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
    let repoLock: Awaited<ReturnType<typeof acquireQueueRepoLock>>;
    try {
      repoLock = await acquireQueueRepoLock(repoPath, `merge-train:${label}`, { timeoutMs: MERGE_TRAIN_REPO_LOCK_TIMEOUT_MS });
    } catch (err) {
      const reason = `could not acquire the repo lock within ${Math.round(MERGE_TRAIN_REPO_LOCK_TIMEOUT_MS / 60_000)}m: ${errorMessage(err)}`;
      unregisterLiveMergeTrain(trainId);
      await updateMergeTrainState(trainId, { state: "abandoned", reconciledReason: reason, finishedAt: new Date().toISOString() }, database).catch(() => undefined);
      yield { type: "error", workspaceId: first.id, issueNumber: first.issueNumber, issueTitle: first.issueTitle, error: `train abandoned: ${reason}` };
      yield { type: "done", merged: [], failed: members.map((m) => m.workspaceId), skipped: [] };
      return;
    }
    const heartbeat = setInterval(() => repoLock.heartbeat(), 15_000);

    let result: Awaited<ReturnType<typeof runMergeTrain>> | null = null;
    try {
      result = await runMergeTrain({
        repoPath,
        baseBranch,
        members,
        label,
        trainId,
        // #1181: an operator cancel or a reconciler verdict can mark this row `abandoned` while
        // the job is still gating. The gate work already in flight when the cancel lands is
        // sunk cost either way, but a train whose row says abandoned must not LAND — nobody is
        // going to account for that merge. Checked at the last moment before `landMergeTrain`,
        // on a fresh read, never on the row captured at start.
        shouldLand: () => vetoLandingIfAbandoned(trainId, database),
        // #1203: checked by the bisect driver before EVERY attempt (root and every half) — a
        // cancel therefore ends the job after the current gate's child process is killed, at
        // the latest, rather than continuing through the rest of a bisect tree.
        signal: abortController.signal,
        runGate: async ({ trainRef, included, label: attemptLabel }) => {
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
          let gateWorktree: string | null = null;
          try {
            // #1203: guarded — a row an operator already cancelled (`abandoned`) or the
            // reconciler already resolved must never be re-marked `gating` by a bisect attempt
            // that started before the cancel and is only now reaching this line. The `signal`
            // check at the top of `landGreenest` is what actually STOPS the next attempt; this
            // guard is the second half — it stops THIS attempt's own bookkeeping from
            // overwriting the operator's verdict while the attempt races to notice the signal.
            await updateMergeTrainState(trainId, { state: "gating", guardStates: ["assembling", "gating"] }, database).catch(() => undefined);
            // #713: DB-backed claim guard alongside the namespace — the train leaf lives
            // under the same `.worktrees` root as every live workspace's.
            gateWorktree = await gitService.createWorktree(repoPath, trainRef, undefined, {
              pathNamespace: "train",
              ...(await resolveWorktreeClaims(database, { label: "merge-train-gate" })),
            });
            // #1154: a builder's worktree gets the project's setup/install script run against
            // it before anything else touches it (`workspace-provision.service.ts`); this
            // staging worktree is created fresh by `createWorktree` above with none of that —
            // so on a project whose dependencies are per-worktree (install-per-worktree, not a
            // symlink into main) the train verified a tree that was never actually installed.
            // Provision it the same way a real workspace is, best-effort: a setup failure here
            // is reported through the gate result below rather than thrown, since a project with
            // no setup script configured (installMode "symlink", or none at all) must still gate
            // normally.
            const setupScript = await getProjectSetupScript(projectId, database).catch(() => null);
            if (setupScript && setupScript.trim()) {
              noteMergeGatePhase(`train:${attemptLabel}`, "install", setupScript);
              const setup = await runSetupScript(gateWorktree, setupScript, {
                timeoutMs: DEFAULT_SETUP_SCRIPT_TIMEOUT_MS,
                // #1203: a cancel kills this install too, not only the verify script — an
                // abandoned train must not keep provisioning a worktree nobody will gate.
                signal: abortController.signal,
              }).catch((err) => ({ exitCode: 1, stdout: "", stderr: errorMessage(err), timedOut: false }));
              if (setup.exitCode !== 0 && !setup.timedOut) {
                return {
                  passed: false,
                  message:
                    `train staging worktree setup failed (exit ${setup.exitCode}) before the gate could run — ` +
                    `dependencies were never installed for this tree, so the gate could not verify anything: ` +
                    `${(setup.stderr || setup.stdout || "no output").slice(0, 500)}`,
                };
              }
            }
            // `memberWorkspaceIds`: the synthetic `train:<label>` id matches no `repos` row, so
            // without it the #628 deferred-install check passes vacuously for the whole train.
            const gate = await runPreMergeGate(
              {
                id: `train:${attemptLabel}`,
                workingDir: gateWorktree,
                baseBranch,
                // The INCLUDED members (#676) — a member dropped during assembly is not in this
                // tree, so its outstanding install must not withhold the train.
                memberWorkspaceIds: included.map((m) => m.workspaceId),
              },
              projectId,
              database,
              // #1203: same token — a cancel mid-verify kills the running gate process instead
              // of letting it run to completion before the row's `abandoned` state is noticed.
              abortController.signal,
            );
            if (!gate.passed) return { passed: false, message: gate.message };
            // #1194: review ONCE, on the tree that just proved green - the assembled diff vs the
            // base, one reviewer, every member's criteria in `{{members}}`. A blocking finding
            // names its member in `sided`; `runMergeTrain` re-lands the rest without it.
            const decision = resolveTrainReviewDecision(toPrefMap(await getAllPreferencesCached(database).catch(() => [])), projectId);
            if (!decision.run) {
              reviewEvidence ??= { status: "skipped", reason: decision.reason };
              return { passed: true, message: gate.message };
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
            reviewEvidence ??= review.evidence;
            return { passed: true, message: gate.message, ...(review.sided.length > 0 ? { sided: review.sided } : {}) };
          } catch (err) {
            // Fail CLOSED: a gate we could not run is not a gate that passed.
            return { passed: false, message: `train gate could not run: ${errorMessage(err)}` };
          } finally {
            // Route the teardown through the #394 co-residency guard rather than deleting
            // outright: this leaf lives under the same `.worktrees` root as every live
            // workspace's, and it was created WITH a claim above — so the claim is exactly
            // what must be consulted before removing it. Enforced by
            // `worktree-delete-guard-ratchet`.
            if (gateWorktree) {
              const dir = gateWorktree;
              await removeWorktreeUnlessShared({
                database,
                workingDir: dir,
                label: "merge-train-gate",
                removeWorktree: () => gitService.removeWorktree(repoPath, dir),
              }).catch(() => undefined);
            }
          }
        },
        // #1204 — the CONTROL ARM, asked once before a red full train is halved: is the BARE
        // BASE red? If it is, the failure belongs to master and no member may be blamed for it.
        gateBaseAlone: () => gateBaseAloneOnce({ database, repoPath, baseBranch, projectId, trainLabel: label }),
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
        onAttempt: (attempt) => appendMergeTrainAttempt(trainId, { ...attempt }, database),
      });
    } finally {
      clearInterval(heartbeat);
      repoLock.release();
    }

    try {
      await finishMergeTrain(trainId, result, members, database, reviewEvidence);
    } finally {
      // #1181: the row's terminal state is persisted (or deliberately left `abandoned`) — only
      // now may a sweep treat it as it finds it. Idempotent with the lock-failure clear above.
      unregisterLiveMergeTrain(trainId);
    }

    // #1191: the member-vs-member conflict clusters are persisted in the evidence above; the
    // deterministic `group-scan` mode `train-conflicts` (`propose_ticket_groups`) reads them
    // back as candidate `coupled_with` groups — proposed, never auto-applied, since coupling
    // two tickets is an operator's call (decision 015).
    if (result.conflictClusters && result.conflictClusters.length > 0) {
      console.log(`[merge-train] ${label}: ${result.conflictClusters.length} member-vs-member conflict cluster(s) recorded — ` +
        `run propose_ticket_groups mode=train-conflicts to review them as candidate ticket groups`);
    }

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
      // Only a drop the author must rebase out of gets a siding. A `deferred` drop (#1191:
      // member-vs-member overlap, re-collected untouched by the next window) is not sided —
      // its tip was never asked to move, so the sha-gate would just hold it for nothing.
      const uniqueDrops = uniqueByWorkspace(result.dropped.filter(isSidingDrop));
      for (const d of uniqueDrops) {
        const member = members.find((m) => m.workspaceId === d.workspaceId);
        if (member) await recordTrainSidingDrop(member, { reason: d.reason, baseBranch, trainTipSha, repoPath }, { database, sendTurn });
      }
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
      yield { type: "error", workspaceId: r.member.workspaceId, issueNumber: r.member.issueNumber ?? null, issueTitle: "", error: `gate failed for this branch alone (bisected out of the train): ${r.reason.slice(0, 300)}` };
    }
    // #1194 - a member the train review sided did NOT land, but its train did (or would have):
    // the findings are already on its ticket, and its branch is untouched. `skipped`, like a
    // conflict drop: this is the author's to fix and re-push, not a batch failure.
    for (const sd of result.sided) {
      if (seenEvent.has(sd.member.workspaceId)) continue;
      seenEvent.add(sd.member.workspaceId);
      yield { type: "skipped", workspaceId: sd.member.workspaceId, issueNumber: sd.member.issueNumber ?? null, issueTitle: "", reason: `sided by the train review: ${sd.reason.slice(0, 300)}` };
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
      `${result.gateRejected.length > 0 ? `, ${result.gateRejected.length} bisected out` : ""}` +
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
