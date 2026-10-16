/**
 * The review-exit gate's red verdict, remembered per branch head (#1299).
 *
 * The review-exit handler withholds `readyForMerge` when its pre-merge gate is red, and until now
 * that left no trace the #932 stranded-review reconciler could read: it saw "review exited clean,
 * never armed" and armed the workspace seconds later, so auto-merge re-gated the same red commit.
 * The verdict is persisted as a `gate-decision` comment carrying the head it judged; the
 * reconciler declines to arm while the current head is that head. A new commit is a new head, so
 * the builder's fix is eligible again with nothing to clear.
 */
import type { Database } from "../../db/index.js";
import { insertIssueComment, listWorkspaceCommentPayloadsByKind, listWorkspaceCommentsWithTimeByKind } from "../../repositories/issue-comments.repository.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export const REVIEW_EXIT_GATE_RED_REASON = "review_exit_gate_red";
/** A gate that never started (host short on memory, %TEMP% exhausted) — not a verdict, retried after a backoff (#1423). */
export const REVIEW_EXIT_GATE_HELD_REASON = "review_exit_gate_held";

/** Delay before re-arming after the Nth consecutive hold on one head; the last entry repeats. */
export const GATE_HELD_RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 45 * 60_000, 2 * 60 * 60_000];

export function gateHeldRetryDelayMs(priorHolds: number): number {
  return GATE_HELD_RETRY_DELAYS_MS[Math.min(priorHolds, GATE_HELD_RETRY_DELAYS_MS.length - 1)];
}

interface GateDecisionPayload { mergeReason?: string; headSha?: string; retryAt?: string; holdReason?: string }

interface RevParser {
  revParse(workingDir: string, ref: string): Promise<string>;
}

/** Record that the review-exit gate withheld `readyForMerge` for the workspace's current head. Never throws. */
export async function markReviewExitGateWithheld(
  input: { workspaceId: string; issueId: string; workingDir: string | null; message: string; now?: string },
  deps: { database: Database; gitService: RevParser },
): Promise<void> {
  try {
    if (!input.workingDir) return;
    const headSha = (await deps.gitService.revParse(input.workingDir, "HEAD")).trim();
    await insertIssueComment({
      issueId: input.issueId,
      workspaceId: input.workspaceId,
      kind: "gate-decision",
      author: "system",
      body: `Pre-merge gate withheld readyForMerge at ${headSha.slice(0, 8)}: ${input.message.slice(0, 500)}`,
      payload: { mergeReason: REVIEW_EXIT_GATE_RED_REASON, headSha },
      createdAt: input.now,
    }, deps.database);
  } catch (err) {
    console.warn(`[workflow] could not record the withheld gate verdict for workspace ${input.workspaceId}: ${errorMessage(err)}`);
  }
}

/**
 * Record that the review-exit gate was HELD (never started) for the current head and when the
 * reconciler may re-arm it (#1423). Returns the retry time, or null when nothing was recorded.
 * Never throws.
 */
export async function markReviewExitGateHeld(
  input: { workspaceId: string; issueId: string; workingDir: string | null; message: string; nowMs?: number },
  deps: { database: Database; gitService: RevParser },
): Promise<string | null> {
  try {
    if (!input.workingDir) return null;
    const headSha = (await deps.gitService.revParse(input.workingDir, "HEAD")).trim();
    const nowMs = input.nowMs ?? Date.now();
    let priorHolds = 0;
    for (const raw of await listWorkspaceCommentPayloadsByKind(input.workspaceId, "gate-decision", deps.database)) {
      const p = raw ? (JSON.parse(raw) as GateDecisionPayload) : null;
      if (p?.mergeReason === REVIEW_EXIT_GATE_HELD_REASON && p.headSha === headSha) priorHolds++;
      else if (p?.mergeReason === REVIEW_EXIT_GATE_RED_REASON) break;
    }
    const retryAt = new Date(nowMs + gateHeldRetryDelayMs(priorHolds)).toISOString();
    const hhmm = retryAt.slice(11, 16);
    await insertIssueComment({
      issueId: input.issueId,
      workspaceId: input.workspaceId,
      kind: "gate-decision",
      author: "system",
      body: `Gate held: waiting for capacity (retry at ${hhmm}Z). ${input.message.slice(0, 400)}`,
      payload: { mergeReason: REVIEW_EXIT_GATE_HELD_REASON, headSha, retryAt, holdReason: input.message.slice(0, 400) },
      createdAt: new Date(nowMs).toISOString(),
    }, deps.database);
    return retryAt;
  } catch (err) {
    console.warn(`[workflow] could not record the held gate for workspace ${input.workspaceId}: ${errorMessage(err)}`);
    return null;
  }
}

/**
 * Is the newest recorded gate decision a HELD marker for exactly `headSha` whose `retryAt` has
 * passed (#1524)? Then the un-armed flag is the hold's doing, not a conflict an earlier
 * `merge-attempt` cleared, and the reconciler must re-arm despite that older merge-attempt row.
 */
export async function isGateHeldRetryDue(database: Database, workspaceId: string, headSha: string, nowMs: number = Date.now()): Promise<boolean> {
  try {
    for (const row of await listWorkspaceCommentsWithTimeByKind(workspaceId, "gate-decision", database)) {
      const payload = row.payload ? (JSON.parse(row.payload) as GateDecisionPayload) : null;
      if (payload?.mergeReason === REVIEW_EXIT_GATE_HELD_REASON) {
        const retryMs = Date.parse(payload.retryAt ?? "");
        if (payload.headSha !== headSha || !Number.isFinite(retryMs) || nowMs < retryMs) return false;
        // A merge attempt AFTER the hold is a real conflict/un-arm, not the hold's doing: re-arming
        // would loop arm -> merge -> conflict -> clear every tick.
        const attempts = await listWorkspaceCommentsWithTimeByKind(workspaceId, "merge-attempt", database);
        return !attempts.some((a) => Date.parse(a.createdAt) > Date.parse(row.createdAt));
      }
      if (payload?.mergeReason === REVIEW_EXIT_GATE_RED_REASON) return false;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Is the newest recorded gate decision for this workspace one that must stop the reconciler arming
 * exactly `headSha`? A red verdict does until the head changes; a HELD gate only until its
 * `retryAt` (#1423). Fail-open on a read error (false): the merge still gates.
 */
export async function isGateWithheldForHead(database: Database, workspaceId: string, headSha: string, nowMs: number = Date.now()): Promise<boolean> {
  try {
    for (const raw of await listWorkspaceCommentPayloadsByKind(workspaceId, "gate-decision", database)) {
      const payload = raw ? (JSON.parse(raw) as GateDecisionPayload) : null;
      if (payload?.mergeReason === REVIEW_EXIT_GATE_HELD_REASON) {
        if (payload.headSha !== headSha) return false;
        const retryMs = Date.parse(payload.retryAt ?? "");
        return Number.isFinite(retryMs) && nowMs < retryMs;
      }
      if (payload?.mergeReason !== REVIEW_EXIT_GATE_RED_REASON) continue;
      return payload.headSha === headSha;
    }
    return false;
  } catch {
    return false;
  }
}
