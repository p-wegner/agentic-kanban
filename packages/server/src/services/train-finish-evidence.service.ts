/**
 * The boarding/finish comment-writing and gate-evidence-building half of the release-train
 * strategy (#906, #1154, #1184, #1188) — split out of `merge-queue-train.ts` (arch-review
 * god-module gate, #1188) once the boarding-pass timeline work pushed that file past the
 * 1000-line hard ceiling. `merge-queue-train.ts` calls these from `beginMergeTrain` and
 * `finishMergeTrain`; nothing here touches the repo lock, the gate worktree, or dispatch.
 */
import type { Database } from "../db/index.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import { getWorkspaceById } from "../repositories/workspace-reads.repository.js";
import type { runMergeTrain } from "./merge-train.service.js";
import type { MergeTrainAttemptDto, MergeTrainGateEvidenceDto } from "@agentic-kanban/shared/types";

/**
 * One issue comment per member at boarding time (#1188) — reusing `insertIssueComment` (the
 * single write path, #737/#738) rather than a second comment-writing mechanism. Best effort:
 * a comment-write failure must never abort assembling the train.
 */
export async function recordBoardingComments(
  trainId: string,
  label: string,
  memberWorkspaceIds: string[],
  database: Database,
): Promise<void> {
  for (const workspaceId of memberWorkspaceIds) {
    try {
      const workspace = await getWorkspaceById(workspaceId, database);
      if (!workspace) continue;
      await insertIssueComment({
        issueId: workspace.issueId,
        workspaceId,
        kind: "merge-attempt",
        author: "system",
        body: `Boarded release train ${label} (${memberWorkspaceIds.length} member(s)).`,
        payload: { eventType: "train-boarded", trainId, label, memberCount: memberWorkspaceIds.length },
      }, database);
    } catch (err) {
      console.warn(`[merge-train] failed to record boarding comment for ${workspaceId} (non-fatal):`, errorMessage(err));
    }
  }
}

/**
 * One issue comment per member at train finish (#1188): landed (naming co-members), dropped
 * (with the conflict reason), bisected out (with the gate failure), or unresolved. Mirrors the
 * event vocabulary `finishMergeTrain`'s caller already yields as `MergeQueueEvent`s, but as a
 * PERSISTED, per-ticket record — those events are transient SSE, not stored anywhere per-issue.
 */
export async function recordFinishComments(
  trainId: string,
  label: string,
  result: Awaited<ReturnType<typeof runMergeTrain>>,
  members: Array<{ workspaceId: string; issueNumber?: number | null }>,
  database: Database,
): Promise<void> {
  const landedIds = new Set(result.landed.map((m) => m.workspaceId));
  // Same FIRST-reason-wins de-dup `buildTrainGateEvidence` uses (`uniqueByWorkspace`) — a
  // bisect re-assembles every sub-attempt from scratch against the base, so a member that
  // conflicts with the base is re-dropped by every attempt that contains it (train qmu4t981a:
  // 17 drops for 13 members). Building the lookup straight from `result.dropped`/`gateRejected`
  // would let the LAST attempt's reason win, diverging from what `gate_evidence` (and the
  // card's own boarding-pass chip, which reads that evidence) records for the same member.
  const dropped = uniqueByWorkspace(result.dropped);
  const gateRejected = uniqueByWorkspace(result.gateRejected);
  const sided = uniqueByWorkspace(result.sided);
  const droppedByWorkspace = new Map(dropped.map((d) => [d.workspaceId, d.reason]));
  const gateRejectedByWorkspace = new Map(gateRejected.map((r) => [r.workspaceId, r.reason]));
  const sidedByWorkspace = new Map(sided.map((s) => [s.workspaceId, s.reason]));
  const issueNumberByWorkspace = new Map(members.map((m) => [m.workspaceId, m.issueNumber ?? null]));

  for (const member of members) {
    const { workspaceId } = member;
    try {
      const workspace = await getWorkspaceById(workspaceId, database);
      if (!workspace) continue;

      let body: string;
      let eventType: string;
      let extra: Record<string, unknown> = {};
      if (landedIds.has(workspaceId)) {
        const coMembers = members
          .filter((m) => m.workspaceId !== workspaceId && landedIds.has(m.workspaceId))
          .map((m) => issueNumberByWorkspace.get(m.workspaceId))
          .filter((n): n is number => n !== null && n !== undefined);
        eventType = "train-landed";
        body = coMembers.length > 0
          ? `Landed via release train ${label}, together with ${coMembers.map((n) => `#${n}`).join(", ")}.`
          : `Landed via release train ${label}.`;
        extra = { coMemberIssueNumbers: coMembers };
      } else if (droppedByWorkspace.has(workspaceId)) {
        const reason = droppedByWorkspace.get(workspaceId)!;
        eventType = "train-dropped";
        body = `Dropped from release train ${label}: ${reason.slice(0, 300)}`;
        extra = { reason };
      } else if (gateRejectedByWorkspace.has(workspaceId)) {
        const reason = gateRejectedByWorkspace.get(workspaceId)!;
        eventType = "train-bisected-out";
        body = `Bisected out of release train ${label} — the gate failed for this branch alone: ${reason.slice(0, 300)}`;
        extra = { reason };
      } else if (sidedByWorkspace.has(workspaceId)) {
        // #1194: a member the train review sided is attributed (to its own ticket), not
        // unresolved — the same distinction `buildTrainGateEvidence`'s `accounted` set draws.
        const reason = sidedByWorkspace.get(workspaceId)!;
        eventType = "train-sided";
        body = `Sided out of release train ${label} by review: ${reason.slice(0, 300)}`;
        extra = { reason };
      } else {
        eventType = "train-unresolved";
        body = `Release train ${label} failed and this ticket's disposition was never individually attributed.`;
      }

      await insertIssueComment({
        issueId: workspace.issueId,
        workspaceId,
        kind: "merge-attempt",
        author: "system",
        body,
        payload: { eventType, trainId, label, ...extra },
      }, database);
    } catch (err) {
      console.warn(`[merge-train] failed to record finish comment for ${workspaceId} (non-fatal):`, errorMessage(err));
    }
  }
}

/**
 * One entry per workspace id, first reason wins (#1184). A bisect re-assembles every
 * sub-attempt from scratch against the base, so a member that conflicts with the BASE is
 * re-dropped by every attempt that contains it — train qmu4t981a persisted 17 drops for 13
 * members, and the panel's red-debt (dropped minus landed) was wrong in sign and size. The
 * first reason is kept because it is the top-level attempt's, recorded against the full batch.
 */
export function uniqueByWorkspace<T extends { member: { workspaceId: string }; reason: string; deferred?: true }>(
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
