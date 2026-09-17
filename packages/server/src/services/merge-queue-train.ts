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
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { getMergeQueueIssueRows, getMergeTrainMaxSizePref } from "../repositories/merge-queue.repository.js";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { resolveTrainOptInSize } from "./merge-train-window.js";
import { resolveRiskPosture, formatPostureNote, type RiskPosture } from "./risk-posture.service.js";
import {
  appendMergeTrainAttempt,
  createMergeTrain,
  getMergeTrain,
  listActiveMergeTrainsForProject,
  updateMergeTrainState,
} from "../repositories/merge-train.repository.js";
import { runMergeTrain } from "./merge-train.service.js";
import { registerLiveMergeTrain, unregisterLiveMergeTrain } from "./merge-train-live-registry.js";
import { runPreMergeGate, looksLikeMissingDepsFailure } from "./pre-merge-gate.service.js";
import { resolveWorktreeClaims, removeWorktreeUnlessShared } from "@agentic-kanban/shared/lib/worktree-claim";
import { randomUUID } from "node:crypto";
import { acquireQueueRepoLock, MERGE_TRAIN_REPO_LOCK_TIMEOUT_MS } from "./merge-queue-repo-lock.js";
import type { MergeQueueEvent, MergeQueuePlan } from "./merge-queue.service.js";
import type { MergeTrainGateEvidenceDto } from "@agentic-kanban/shared/types";
import { getProjectSetupScript } from "../repositories/stack-profile.repository.js";
import { DEFAULT_SETUP_SCRIPT_TIMEOUT_MS, runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import { noteMergeGatePhase } from "./merge-job.service.js";
import { formatIneligibleNote, trainMemberIneligibility } from "./merge-release-partition.js";

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
  label: string,
  memberWorkspaceIds: string[],
  database: Database,
): Promise<{ trainId: string; projectId: string } | null | "already_in_flight"> {
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

  const trainId = randomUUID();
  await createMergeTrain({ id: trainId, projectId, label, memberWorkspaceIds }, database);
  return { trainId, projectId };
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
  const { gateEvidence, gateRejected } = buildTrainGateEvidence(result, members);
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
function uniqueByWorkspace<T extends { member: { workspaceId: string }; reason: string }>(
  entries: T[],
): Array<{ workspaceId: string; reason: string }> {
  const seen = new Set<string>();
  const out: Array<{ workspaceId: string; reason: string }> = [];
  for (const e of entries) {
    if (seen.has(e.member.workspaceId)) continue;
    seen.add(e.member.workspaceId);
    out.push({ workspaceId: e.member.workspaceId, reason: e.reason });
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
): { gateEvidence: MergeTrainGateEvidenceDto; gateRejected: Array<{ workspaceId: string; reason: string }> } {
  const dropped = uniqueByWorkspace(result.dropped);
  const gateRejected = uniqueByWorkspace(result.gateRejected);
  const landed = result.landed.map((m) => m.workspaceId);
  const accounted = new Set([
    ...landed,
    ...dropped.map((d) => d.workspaceId),
    ...gateRejected.map((r) => r.workspaceId),
  ]);
  const unresolved = members.filter((m) => !accounted.has(m.workspaceId)).map((m) => m.workspaceId);
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
      // #1189: the complete bisect tree, replacing the live appends made as each node finished.
      attempts: result.attempts,
    },
    gateRejected,
  };
}

/**
 * Build the train-strategy runner for `createMergeQueueService`. `reconcileAlreadyMerged` is
 * injected rather than importing `workspace-merge.service.ts` directly here, so this module
 * doesn't need its own copy of that service's construction — the caller already built one.
 */
export function createMergeTrainRunner(deps: {
  database: Database;
  reconcileAlreadyMerged: (workspaceId: string) => Promise<unknown>;
}) {
  const { database, reconcileAlreadyMerged } = deps;

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
    const first = plan.order[0];
    const repoPath = first.repoPath;
    const baseBranch = first.baseBranch as string;
    const label = `q${Date.now().toString(36)}`;
    const members = plan.order.map((ws) => ({
      workspaceId: ws.id,
      branch: ws.branch as string,
      issueNumber: ws.issueNumber,
    }));

    const trainStart = await beginMergeTrain(first, label, members.map((m) => m.workspaceId), database);
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
    const { trainId, projectId } = trainStart;
    // #1181: from here until `finishMergeTrain` this row has a live job in THIS process. The
    // reconciler's periodic sweep reads the registry and leaves registered rows alone; without
    // it the sweep applied its boot-time "nothing can be live" rule to a train mid-gate.
    registerLiveMergeTrain({ trainId, label, projectId });

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
        // #1181: an operator cancel or a reconciler verdict can mark this row `abandoned` while
        // the job is still gating (there is no cancellation token into `runMergeTrain`). The
        // gate work is sunk cost either way, but a train whose row says abandoned must not
        // LAND — nobody is going to account for that merge. Checked at the last moment before
        // `landMergeTrain`, on a fresh read, never on the row captured at start.
        shouldLand: () => vetoLandingIfAbandoned(trainId, database),
        runGate: async ({ trainRef, included }) => {
          // Gate the TREE THAT LANDS. A per-member gate never tests the merge commit, which is
          // how two individually-green branches can produce a red base with no conflict.
          let gateWorktree: string | null = null;
          try {
            await updateMergeTrainState(trainId, { state: "gating" }, database).catch(() => undefined);
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
              noteMergeGatePhase(`train:${label}`, "install", setupScript);
              const setup = await runSetupScript(gateWorktree, setupScript, {
                timeoutMs: DEFAULT_SETUP_SCRIPT_TIMEOUT_MS,
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
                id: `train:${label}`,
                workingDir: gateWorktree,
                baseBranch,
                // The INCLUDED members (#676) — a member dropped during assembly is not in this
                // tree, so its outstanding install must not withhold the train.
                memberWorkspaceIds: included.map((m) => m.workspaceId),
              },
              projectId,
              database,
            );
            return { passed: gate.passed, message: gate.message };
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
        closeMember: async (workspaceId) => {
          // Reuse the sanctioned already-merged path rather than reimplementing the
          // mergedAt/status/comment bookkeeping the reconcilers depend on.
          await reconcileAlreadyMerged(workspaceId);
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
      await finishMergeTrain(trainId, result, members, database);
    } finally {
      // #1181: the row's terminal state is persisted (or deliberately left `abandoned`) — only
      // now may a sweep treat it as it finds it. Idempotent with the lock-failure clear above.
      unregisterLiveMergeTrain(trainId);
    }

    // #1184: one event per member — a bisect re-drops a base-conflicting member in every
    // sub-attempt that contains it, and the queue must not hear "skipped" N times for one ticket.
    const seenEvent = new Set<string>();
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
    if (result.landed.length === 0) {
      for (const m of members) {
        if (result.dropped.some((d) => d.member.workspaceId === m.workspaceId)) continue;
        if (result.gateRejected.some((r) => r.member.workspaceId === m.workspaceId)) continue;
        yield { type: "error", workspaceId: m.workspaceId, issueNumber: m.issueNumber ?? null, issueTitle: "", error: `train gate failed — nothing landed: ${(result.gateFailure ?? "").slice(0, 300)}` };
      }
      yield { type: "done", merged: [], failed: members.map((m) => m.workspaceId), skipped: [] };
      return;
    }
    console.log(`[merge-train] ${label}: ${result.landed.length}/${members.length} landed in ${result.gateRuns} gate run(s)` +
      `${result.gateRejected.length > 0 ? `, ${result.gateRejected.length} bisected out` : ""}`);
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
      skipped: result.dropped.map((d) => d.member.workspaceId),
    };
  }

  return { runTrainStrategy };
}
