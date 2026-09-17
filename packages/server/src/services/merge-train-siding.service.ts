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
 *    is still the sha recorded at the last siding. The record is deleted the moment the tip
 *    moves — that IS "re-admitted", nothing else has to notice.
 *  - **A cap** (`TRAIN_SIDING_MAX_ATTEMPTS`) stops the nudging once it has clearly stopped
 *    working: past the cap the member stays withheld (same sha-gate) but is left alone rather
 *    than nudged again, and ONE issue comment (edge-triggered, like `merge-backoff`'s ceiling
 *    warning) tells a human the train gave up on it.
 *
 * Ownership rule: this module NEVER rewrites a member's branch. It only asks — the same
 * ownership boundary `runMergeTrain`'s own docs describe for a conflict ("the author's to
 * rebase"), as opposed to a gate failure ("the author's to FIX").
 */
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { revParse } from "@agentic-kanban/shared/lib/git-service";
import {
  clearTrainSidingState,
  getTrainSidingState,
  setTrainSidingState,
  type TrainSidingRow,
} from "../repositories/merge-train-siding.repository.js";
import { applyIssueTag, removeIssueTag } from "./repo-tags.service.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";

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
  now?: () => Date;
  /** Injected so this module never spawns git directly (@agentic-kanban/shared/lib/git-exec convention). */
  getBranchHeadSha?: (repoPath: string, branch: string) => Promise<string | null>;
  /** 409-safe: a busy agent is expected, not an error — see `sendTurn` on `workspace-session.service.ts`. */
  sendTurn: (workspaceId: string, content: string) => Promise<unknown>;
}

async function defaultGetBranchHeadSha(repoPath: string, branch: string): Promise<string | null> {
  try {
    return (await revParse(repoPath, branch)).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Partition candidate members into those the train should try to assemble this window and
 * those still on a siding — and, as a side effect, CLEAR the siding record for any member
 * whose branch tip has moved since it was recorded (that IS re-admission; nothing else has to
 * notice). Called once per window, before `assembleMergeTrain` ever touches these branches.
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
    // The tip moved (or we could not tell — fail open, admit it). Either way the recorded
    // siding no longer describes the branch as it stands, so it is cleared rather than
    // carried forward stale.
    await clearTrainSidingState(member.workspaceId, database).catch(() => undefined);
    await removeIssueTag(member.issueId, TRAIN_SIDING_TAG, database).catch(() => undefined);
    admitted.push(member);
  }

  return { admitted, held };
}

/**
 * A member just got dropped from assembly for a conflict. Record the siding, nudge its agent
 * (unless the cap is already burned), and tag the workspace — all best-effort: telemetry and a
 * nudge must never throw back into the train's drop-handling loop.
 */
export async function recordTrainSidingDrop(
  member: SidingMember,
  args: { reason: string; baseBranch: string; trainTipSha: string; repoPath: string },
  deps: TrainSidingDeps,
): Promise<void> {
  const database = deps.database ?? db;
  const now = (deps.now ?? (() => new Date()))();
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
      lastSidedAt: now.toISOString(),
      cappedAt: capped ? (existing?.cappedAt ?? now.toISOString()) : null,
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
      console.warn(
        `[merge-train-siding] ${member.workspaceId}${member.issueNumber ? ` (#${member.issueNumber})` : ""} ` +
          `capped at ${sidings} siding(s) — no further nudge`,
      );
      return;
    }

    const prompt = formatSidingTurnPrompt({
      branch: member.branch,
      baseBranch: args.baseBranch,
      conflictTrainTipSha: args.trainTipSha,
      reason: args.reason,
    });
    try {
      await deps.sendTurn(member.workspaceId, prompt);
    } catch (err) {
      // 409-safe: an agent that is busy right now is not an error — the siding record is
      // already written, so the branch stays withheld until it moves regardless of whether
      // this particular nudge was delivered.
      console.warn(`[merge-train-siding] could not nudge ${member.workspaceId} (non-fatal): ${errorMessage(err).slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[merge-train-siding] could not record siding for ${member.workspaceId} (non-fatal): ${errorMessage(err).slice(0, 200)}`);
  }
}

/** A member landed (or was otherwise resolved) — drop any siding memory for it. */
export async function clearTrainSiding(member: Pick<SidingMember, "workspaceId" | "issueId">, deps: TrainSidingDeps): Promise<void> {
  const database = deps.database ?? db;
  await clearTrainSidingState(member.workspaceId, database).catch(() => undefined);
  await removeIssueTag(member.issueId, TRAIN_SIDING_TAG, database).catch(() => undefined);
}
