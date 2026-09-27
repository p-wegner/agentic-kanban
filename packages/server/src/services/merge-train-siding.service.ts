/**
 * Sidings (#1192): a merge-train member dropped for a conflict gets a rebase turn instead of
 * silence, and stays out of the train's candidate set until its branch actually moves.
 *
 * Today's failure (before this file existed): `assembleMergeTrain` drops a conflicting member
 * and leaves its branch untouched — no signal to the agent that owns it, and nothing excludes
 * the member from the very next window, so it is released straight back into the same
 * conflict every cycle.
 *
 * The fix has three moving parts:
 *  - **On drop**, tell the agent (a `/turn`, 409-safe — a busy agent is not an error, just
 *    means the nudge is redundant this tick) exactly what conflicted, against which train tip,
 *    and that `update-base` is the way out — the same instruction #1169's stale-base refusal
 *    already gives on the sequential path, reused here rather than re-worded. Tag the
 *    workspace `train-siding` while a rebase is presumably in flight, for visibility.
 *  - **Re-admission is keyed on the branch tip**, the same shape `monitor-gate-recall` uses for
 *    the sequential review gate: a member is held out of assembly for as long as its branch tip
 *    is still the sha recorded at the last siding. The branch-sha gate is cleared the moment the
 *    tip moves — that IS "re-admitted", nothing else has to notice — but the `sidings`/`cappedAt`
 *    counters are NOT reset by a re-admission: only landing (`clearTrainSiding`) is a full reset.
 *    Otherwise every successful rebase would silently zero the cap, and a branch that keeps
 *    genuinely rebasing into a new conflict every window would never reach the cap.
 *  - **A cap** (`TRAIN_SIDING_MAX_ATTEMPTS`) stops the nudging once it has clearly stopped
 *    working: past the cap the member stays withheld (same sha-gate) but is left alone rather
 *    than nudged again, and ONE issue comment (edge-triggered, like `merge-backoff`'s ceiling
 *    warning) tells a human the train gave up on it.
 *
 * Ownership rule: this module NEVER rewrites a member's branch. It only asks — the same
 * ownership boundary `runMergeTrain`'s own docs describe for a conflict ("the author's to
 * rebase"), as opposed to a gate failure ("the author's to FIX").
 *
 * **Follow-up (#1210):** `sendTurn` only ever delivers a `/turn` to a LIVE session — if the
 * member's owning session has already exited (the agent is gone), a `/turn` has nothing to
 * resume into cleanly and `workspace-session.service.ts`'s own `sendTurn` falls through to a
 * fresh `startSession` with `resumeFromId` set, launched straight into whatever the worktree
 * already is — the exact #1209 bug (agent sees a clean tree, reports "nothing to resolve"),
 * recurring via the siding path specifically because nothing here ever rebases the worktree
 * first. #1210 answered that with `resolveConflicts` (rebase-first, then a fix-conflicts agent).
 *
 * **Base-conflict send-back (live gap 2026-09-27):** a conflict drop now carries `trainRef` and
 * is a SEND-BACK (`merge-train-send-back.ts`). It runs the moment assembly drops the member
 * (`createTrainDropSendBack`, called from inside the train), not after the whole gate and bisect;
 * it takes the member out of the ready set with a visible reason; and it gives the builder ONE
 * instruction that names the rebase itself, as a `/turn` to a live session or a builder relaunch
 * (`relaunch`, the `POST /:id/launch` path) when the agent is gone. The relaunch replaced
 * `resolveConflicts` here because a fix-conflicts session exits through fix-and-merge, which
 * lands the branch on its own, outside the train; a builder session exits through review and
 * the review-exit gate, which re-arm `readyForMerge` so the member rejoins a later train. Past
 * the cap the member gets a merge hold (needs attention) instead of another send-back.
 */
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { revParse } from "@agentic-kanban/shared/lib/git-service";
import {
  conflictFilesFromReason,
  formatBaseConflictSendBackPrompt,
  holdAfterSendBackCap,
  restoreReadyAfterFailedSendBack,
  withholdForSendBack,
} from "./merge-train-send-back.js";
import {
  clearTrainSidingState,
  getTrainSidingState,
  setTrainSidingState,
  type TrainSidingRow,
} from "../repositories/merge-train-siding.repository.js";
import { applyIssueTag, removeIssueTag } from "./repo-tags.service.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import { findRunningSession } from "../repositories/session.repository.js";

export const TRAIN_SIDING_MAX_ATTEMPTS = 3;
export const TRAIN_SIDING_TAG = "train-siding";
const TRAIN_SIDING_TAG_COLOR = "#f59e0b";

export interface SidingMember {
  workspaceId: string;
  issueId: string;
  issueNumber?: number | null;
  branch: string;
}

/**
 * Is `sha` still the sha this member was sided at? Pure — the same "recorded sha == current
 * sha means nothing has changed yet" decision `monitor-gate-recall` makes for the review gate,
 * lifted out so it can be tested without a DB or a git checkout.
 */
export function isStillSided(row: Pick<TrainSidingRow, "sidedBranchSha"> | undefined, currentSha: string | null): boolean {
  if (!row || !row.sidedBranchSha || !currentSha) return false;
  return row.sidedBranchSha === currentSha;
}

/**
 * Is this drop one a siding is FOR? Only a drop the author has to rebase out of — a conflict
 * against what is already on the train / the base. A drop marked `deferred` (#1191: the member
 * conflicts with a SIBLING member, so the assembly left it for the next train, where it is
 * collected again untouched) needs no rebase, and siding it would hold a branch at an unchanged
 * tip that was never asked to move — until the cap, for nothing. Structural `deferred?` so this
 * typechecks against a `DroppedTrainMember` with or without that field; a drop that does not
 * carry it is a rebase case, which is every drop this branch itself produces.
 */
export function isSidingDrop(drop: { reason: string; deferred?: boolean }): boolean {
  return !drop.deferred;
}

/** Has this member burned its siding cap and been left withheld rather than nudged again? */
export function isSidingCapped(row: Pick<TrainSidingRow, "cappedAt"> | undefined): boolean {
  return Boolean(row?.cappedAt);
}

export function formatSidingTurnPrompt(args: {
  branch: string;
  baseBranch: string;
  conflictTrainTipSha: string;
  reason: string;
}): string {
  return (
    `The merge train dropped this branch (${args.branch}) from batch ${args.conflictTrainTipSha.slice(0, 8)} because it ` +
    `conflicts with work already on the train: ${args.reason.slice(0, 500)}\n\n` +
    `The train will not rewrite your branch — a conflict is yours to rebase (#1192). Please run ` +
    `\`update-base\` (rebase onto '${args.baseBranch}') to resolve it, then push. Once your branch's ` +
    `tip moves, the train will pick it back up in the next window.`
  );
}

export interface TrainSidingDeps {
  database?: Database;
  /** ISO — the value lands in `lastSidedAt`/`cappedAt` (the persisted-value spelling, #614). */
  now?: string;
  /** Injected so this module never spawns git directly (@agentic-kanban/shared/lib/git-exec convention). */
  getBranchHeadSha?: (repoPath: string, branch: string) => Promise<string | null>;
  /** 409-safe: a busy agent is expected, not an error — see `sendTurn` on `workspace-session.service.ts`. */
  sendTurn: (workspaceId: string, content: string) => Promise<unknown>;
  /**
   * #1210 — is there a live/running session to receive a `/turn` at all? Defaults to a real
   * check (`findRunningSession`). Injected so tests can force either branch without a session
   * table. When absent (agent gone), `recordTrainSidingDrop` routes through `relaunch`
   * instead of `sendTurn`.
   */
  hasLiveSession?: (workspaceId: string) => Promise<boolean>;
  /**
   * Relaunch the member's builder with `prompt` (the `POST /:id/launch` path) when it has no live
   * session. The prompt names the rebase itself, so a fresh session on an un-rebased tree still
   * has something to do (see the module doc for why this replaced `resolveConflicts`). Optional
   * so callers that never hit the agentless branch need not supply it; if it IS needed and
   * absent, the drop still records and just skips the nudge.
   */
  relaunch?: (workspaceId: string, prompt: string) => Promise<unknown>;
}

async function defaultGetBranchHeadSha(repoPath: string, branch: string): Promise<string | null> {
  try {
    return (await revParse(repoPath, branch)).trim() || null;
  } catch {
    return null;
  }
}

/** #1210: real "is there a live session" check — a `sessions` row with `status === "running"`. */
async function defaultHasLiveSession(workspaceId: string, database: Database): Promise<boolean> {
  return Boolean(await findRunningSession(workspaceId, database));
}

/**
 * Partition candidate members into those the train should try to assemble this window and
 * those still on a siding — and, as a side effect, CLEAR the branch-sha gate (not the sidings
 * counter) for any member whose branch tip has moved since it was recorded (that IS
 * re-admission; nothing else has to notice). Called once per window, before
 * `assembleMergeTrain` ever touches these branches.
 */
export async function partitionSidedMembers<M extends SidingMember>(
  members: M[],
  repoPath: string,
  deps: TrainSidingDeps,
): Promise<{ admitted: M[]; held: Array<{ member: M; reason: string }> }> {
  const database = deps.database ?? db;
  const getBranchHeadSha = deps.getBranchHeadSha ?? defaultGetBranchHeadSha;
  const admitted: M[] = [];
  const held: Array<{ member: M; reason: string }> = [];

  for (const member of members) {
    const row = await getTrainSidingState(member.workspaceId, database).catch(() => undefined);
    if (!row) {
      admitted.push(member);
      continue;
    }
    const currentSha = await getBranchHeadSha(repoPath, member.branch);
    if (isStillSided(row, currentSha)) {
      const reason = isSidingCapped(row)
        ? `withheld after ${row.sidings} siding(s) — waiting for a human or a rebase, not retried automatically`
        : `still on siding ${row.sidings} — waiting for its branch to move before rejoining the train`;
      held.push({ member, reason });
      continue;
    }
    // The tip moved (or we could not tell — fail open, admit it). Clear the branch-sha GATE
    // so the member is no longer held — but keep `sidings`/`cappedAt`. Deleting the whole row
    // here would reset the cap counter to zero on every successful rebase, so a branch that
    // genuinely rebases each time but keeps landing on a NEW conflict with the train would
    // nudge forever and never reach `TRAIN_SIDING_MAX_ATTEMPTS` — exactly the repeated-futile-
    // cycle case the cap exists to catch. `clearTrainSiding` (called on landing) is still the
    // full reset, for the case that actually resolves the siding.
    await setTrainSidingState(member.workspaceId, {
      sidings: row.sidings,
      sidedBranchSha: null,
      conflictTrainTipSha: row.conflictTrainTipSha,
      lastSidedAt: row.lastSidedAt ?? new Date(0).toISOString(),
      cappedAt: row.cappedAt,
    }, database).catch(() => undefined);
    await removeIssueTag(member.issueId, TRAIN_SIDING_TAG, database).catch(() => undefined);
    admitted.push(member);
  }

  return { admitted, held };
}

/**
 * A member just got dropped from assembly for a conflict. Record the siding, nudge its agent
 * (unless the cap is already burned), and tag the workspace — all best-effort: telemetry and a
 * nudge must never throw back into the train's drop-handling loop.
 *
 * With `trainRef` set the drop is a base-conflict SEND-BACK (`merge-train-send-back.ts`): the
 * member also leaves the ready set with a visible reason, the nudge carries the rebase
 * instruction, one `[merge-train] sent back …` line is logged, and past the cap it gets a merge
 * hold. Without it (the train review's siding, #1194) the behaviour is exactly as before.
 */
export async function recordTrainSidingDrop(
  member: SidingMember,
  args: { reason: string; baseBranch: string; trainTipSha: string; repoPath: string; trainRef?: string },
  deps: TrainSidingDeps,
): Promise<void> {
  const database = deps.database ?? db;
  const nowIso = deps.now ?? new Date().toISOString();
  try {
    const existing = await getTrainSidingState(member.workspaceId, database);
    const sidings = (existing?.sidings ?? 0) + 1;
    const capped = sidings >= TRAIN_SIDING_MAX_ATTEMPTS;
    const wasAlreadyCapped = isSidingCapped(existing);
    const currentSha = await (deps.getBranchHeadSha ?? defaultGetBranchHeadSha)(
      args.repoPath,
      member.branch,
    ).catch(() => null);

    await setTrainSidingState(member.workspaceId, {
      sidings,
      sidedBranchSha: currentSha,
      conflictTrainTipSha: args.trainTipSha,
      lastSidedAt: nowIso,
      cappedAt: capped ? (existing?.cappedAt ?? nowIso) : null,
    }, database);

    await applyIssueTag(member.issueId, TRAIN_SIDING_TAG, TRAIN_SIDING_TAG_COLOR, database).catch(() => undefined);

    if (capped) {
      // Edge-triggered: comment once, the first time the cap is crossed, never once per cycle.
      if (!wasAlreadyCapped) {
        await insertIssueComment({
          issueId: member.issueId,
          workspaceId: member.workspaceId,
          kind: "merge-attempt",
          author: "system",
          body:
            `The merge train sided this branch ${sidings} time(s) for a conflict and is stopping the ` +
            `automatic rebase nudges (cap ${TRAIN_SIDING_MAX_ATTEMPTS}). The branch is still withheld ` +
            `from the train until it is rebased by hand: \`update-base\` onto '${args.baseBranch}'.\n\n` +
            `Last conflict: ${args.reason.slice(0, 500)}`,
        }, database).catch(() => undefined);
      }
      if (args.trainRef) {
        await holdAfterSendBackCap({ workspaceId: member.workspaceId, drops: sidings, reason: args.reason, now: nowIso, database })
          .catch((err) => console.warn(`[merge-train-siding] could not place the needs-attention hold on ${member.workspaceId}: ${errorMessage(err).slice(0, 200)}`));
      }
      console.warn(
        `[merge-train-siding] ${member.workspaceId}${member.issueNumber ? ` (#${member.issueNumber})` : ""} ` +
          `capped at ${sidings} siding(s) — no further nudge` + (args.trainRef ? "; merge hold placed (needs attention)" : ""),
      );
      return;
    }

    if (!args.trainRef) {
      await deliverSidingNudge(member, formatSidingTurnPrompt({
        branch: member.branch,
        baseBranch: args.baseBranch,
        conflictTrainTipSha: args.trainTipSha,
        reason: args.reason,
      }), deps, database);
      return;
    }
    await sendBackForRebase(member, { ...args, trainRef: args.trainRef, sendBack: sidings, now: nowIso }, deps, database);
  } catch (err) {
    console.warn(`[merge-train-siding] could not record siding for ${member.workspaceId} (non-fatal): ${errorMessage(err).slice(0, 200)}`);
  }
}

/**
 * Deliver one nudge: a `/turn` to a live session, or a builder relaunch when the agent is gone
 * (a `/turn` to a dead session falls through to a fresh `startSession` in an un-rebased tree,
 * #1209/#1210; the relaunch prompt names the rebase, so that tree is the expected start).
 * Returns how it was delivered, or null when it was not. Never throws.
 */
async function deliverSidingNudge(
  member: SidingMember,
  prompt: string,
  deps: TrainSidingDeps,
  database: Database,
): Promise<"turn" | "relaunch" | null> {
  const checkLiveSession = deps.hasLiveSession ?? ((workspaceId: string) => defaultHasLiveSession(workspaceId, database));
  const isLive = await checkLiveSession(member.workspaceId).catch(() => true);
  if (!isLive) {
    if (!deps.relaunch) {
      console.warn(`[merge-train-siding] ${member.workspaceId} has no live session and no relaunch port was supplied — siding recorded, no nudge sent`);
      return null;
    }
    try {
      await deps.relaunch(member.workspaceId, prompt);
      return "relaunch";
    } catch (err) {
      console.warn(`[merge-train-siding] could not relaunch the builder of idle ${member.workspaceId} (non-fatal): ${errorMessage(err).slice(0, 200)}`);
      return null;
    }
  }
  try {
    await deps.sendTurn(member.workspaceId, prompt);
    return "turn";
  } catch (err) {
    // 409-safe: an agent that is busy right now is not an error — the siding record is
    // already written, so the branch stays withheld until it moves regardless of whether
    // this particular nudge was delivered.
    console.warn(`[merge-train-siding] could not nudge ${member.workspaceId} (non-fatal): ${errorMessage(err).slice(0, 200)}`);
    return null;
  }
}

/**
 * The base-conflict send-back: withhold `readyForMerge` (visible reason), send the builder the
 * rebase instruction, log one line. A send-back that could not be delivered puts the flag back,
 * so the member is exactly where the siding alone would have left it (held until its tip moves).
 */
async function sendBackForRebase(
  member: SidingMember,
  args: { reason: string; baseBranch: string; trainRef: string; sendBack: number; now: string },
  deps: TrainSidingDeps,
  database: Database,
): Promise<void> {
  const maxSendBacks = TRAIN_SIDING_MAX_ATTEMPTS - 1;
  await withholdForSendBack({
    workspaceId: member.workspaceId, issueId: member.issueId, branch: member.branch, trainRef: args.trainRef,
    reason: args.reason, sendBack: args.sendBack, maxSendBacks, now: args.now, database,
  });
  const prompt = formatBaseConflictSendBackPrompt({ branch: member.branch, baseBranch: args.baseBranch, trainRef: args.trainRef, reason: args.reason });
  const delivered = await deliverSidingNudge(member, prompt, deps, database);
  const who = `${member.branch}${member.issueNumber ? ` (#${member.issueNumber})` : ""}`;
  if (!delivered) {
    await restoreReadyAfterFailedSendBack(member.workspaceId, args.now, database).catch(() => undefined);
    console.warn(`[merge-train] could not send back ${who} from train ${args.trainRef} — readyForMerge restored, still held on its siding until the branch moves`);
    return;
  }
  const files = conflictFilesFromReason(args.reason);
  console.log(
    `[merge-train] sent back ${who} from train ${args.trainRef} (send-back ${args.sendBack}/${maxSendBacks}): ` +
      `base conflict in ${files.length > 0 ? files.join(", ") : "unnamed files"} — readyForMerge withheld, ` +
      (delivered === "turn" ? "builder nudged with a /turn" : "builder relaunched"),
  );
}

type TrainDrop = { member: { workspaceId: string }; reason: string; deferred?: boolean };

/**
 * One train's send-back port (live gap 2026-09-27). `runMergeTrain` calls `onDropped` the moment
 * an assembly drops members, and the train strategy calls it again with the final result, so a
 * member is sent back at most ONCE per train (a bisect or a re-assembly re-drops the same
 * member). Only a drop the author must rebase out of is sent back: a `deferred` drop (#1191,
 * member-vs-member) is left for the next train untouched, exactly as before.
 */
export function createTrainDropSendBack(args: {
  members: SidingMember[];
  baseBranch: string;
  repoPath: string;
  deps: TrainSidingDeps;
}): { onDropped: (dropped: TrainDrop[], at: { trainRef: string; tipSha: string }) => Promise<void> } {
  const sentBack = new Set<string>();
  async function onDropped(dropped: TrainDrop[], at: { trainRef: string; tipSha: string }): Promise<void> {
    for (const d of dropped) {
      if (!isSidingDrop(d) || sentBack.has(d.member.workspaceId)) continue;
      const member = args.members.find((m) => m.workspaceId === d.member.workspaceId);
      if (!member) continue;
      sentBack.add(member.workspaceId);
      await recordTrainSidingDrop(member, {
        reason: d.reason, baseBranch: args.baseBranch, trainTipSha: at.tipSha, repoPath: args.repoPath, trainRef: at.trainRef,
      }, args.deps);
    }
  }
  return { onDropped };
}

/** A member landed (or was otherwise resolved) — drop any siding memory for it. */
export async function clearTrainSiding(member: Pick<SidingMember, "workspaceId" | "issueId">, deps: TrainSidingDeps): Promise<void> {
  const database = deps.database ?? db;
  await clearTrainSidingState(member.workspaceId, database).catch(() => undefined);
  await removeIssueTag(member.issueId, TRAIN_SIDING_TAG, database).catch(() => undefined);
}
