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
import { createMergeTrain, updateMergeTrainState } from "../repositories/merge-train.repository.js";
import { runMergeTrain } from "./merge-train.service.js";
import { runPreMergeGate } from "./pre-merge-gate.service.js";
import { resolveWorktreeClaims, removeWorktreeUnlessShared } from "@agentic-kanban/shared/lib/worktree-claim";
import { randomUUID } from "node:crypto";
import { acquireQueueRepoLock } from "./merge-queue-repo-lock.js";
import type { MergeQueueEvent, MergeQueuePlan } from "./merge-queue.service.js";

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
      !ws.isDirect &&
      ws.workingDir &&
      ws.branch &&
      ws.repoPath === first.repoPath &&
      ws.baseBranch === first.baseBranch,
  );
}

/**
 * Resolve the batch's project and persist its `merge_trains` row BEFORE any git/gate work
 * (#906), so a crash mid-assembly still leaves a row the startup reconciler can find. Returns
 * `null` when the project cannot be resolved — there is then no `verify_script` to gate with,
 * so the caller must fail closed rather than run a train with no gate.
 */
async function beginMergeTrain(
  first: { issueId: string },
  label: string,
  memberWorkspaceIds: string[],
  database: Database,
): Promise<{ trainId: string; projectId: string } | null> {
  // The gate is per-PROJECT (it reads verify_script_<projectId>), and WorkspaceQueueInfo
  // carries only issueId — resolve the project the same way computePlan does.
  const issueRows = await getMergeQueueIssueRows([first.issueId], database);
  const projectId = issueRows[0]?.projectId ?? null;
  if (!projectId) return null;

  const trainId = randomUUID();
  await createMergeTrain({ id: trainId, projectId, label, memberWorkspaceIds }, database);
  return { trainId, projectId };
}

/**
 * Persist a train's final state and the evidence a "Merge train" panel/history view reads
 * (#906). Best effort — a bookkeeping failure here must never be reported as the train itself
 * failing; the git-level outcome already happened and is what the caller's events describe.
 */
async function finishMergeTrain(
  trainId: string,
  result: Awaited<ReturnType<typeof runMergeTrain>>,
  database: Database,
): Promise<void> {
  await updateMergeTrainState(trainId, {
    state: result.landed.length > 0 ? "landed" : "red",
    gateEvidence: {
      gateRuns: result.gateRuns,
      gateFailure: result.gateFailure ?? null,
      landed: result.landed.map((m) => m.workspaceId),
      dropped: result.dropped.map((d) => ({ workspaceId: d.member.workspaceId, reason: d.reason })),
      mergeSha: result.mergeSha ?? null,
    },
    bisectResult: result.gateRejected.length > 0
      ? { gateRejected: result.gateRejected.map((r) => ({ workspaceId: r.member.workspaceId, reason: r.reason })) }
      : null,
    finishedAt: new Date().toISOString(),
  }, database).catch((err) => console.warn(`[merge-train] failed to persist final state for ${trainId} (non-fatal):`, errorMessage(err)));
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
    if (!trainStart) {
      // Fail closed rather than gate-less: without a project there is no verify_script to run,
      // and a train that skips the gate is exactly what this feature must never become.
      yield { type: "error", workspaceId: first.id, issueNumber: first.issueNumber, issueTitle: first.issueTitle, error: "train aborted: could not resolve the project for the batch, so the gate could not be run" };
      yield { type: "done", merged: [], failed: members.map((m) => m.workspaceId), skipped: [] };
      return;
    }
    const { trainId, projectId } = trainStart;

    const repoLock = await acquireQueueRepoLock(repoPath, `merge-train:${label}`);
    const heartbeat = setInterval(() => repoLock.heartbeat(), 15_000);

    let result: Awaited<ReturnType<typeof runMergeTrain>> | null = null;
    try {
      result = await runMergeTrain({
        repoPath,
        baseBranch,
        members,
        label,
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
      });
    } finally {
      clearInterval(heartbeat);
      repoLock.release();
    }

    await finishMergeTrain(trainId, result, database);

    for (const d of result.dropped) {
      yield { type: "skipped", workspaceId: d.member.workspaceId, issueNumber: d.member.issueNumber ?? null, issueTitle: "", reason: `dropped from train: ${d.reason.slice(0, 200)}` };
    }
    // #492 — a member the bisect individually proved red is attributed to ITSELF, not blamed
    // on the batch. This is the difference between "your branch broke the gate" and "someone
    // in a batch you were in broke the gate", and only the first is actionable by its author.
    for (const r of result.gateRejected) {
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
