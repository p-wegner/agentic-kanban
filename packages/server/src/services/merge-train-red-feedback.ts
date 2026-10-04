/**
 * A red merge train goes back to its members' builders (#1298; the single-workspace gate is #1293,
 * `gate-red-feedback.ts`).
 *
 * Two shapes, both sending the SAME one-turn feedback (cap, prompt, infra-class exclusion all live
 * in `sendGateRedFeedback`):
 *  - a member the bisect or the suite-owner shortcut rejected, with the suites that rejected it;
 *  - under `agent-fix`, a whole train that stayed red after the fix agent: the failing suites are
 *    attributed to the members that touched them (the suite-owner idea, but any number of owners),
 *    and when no member did, EVERY member gets the full failure.
 *
 * This never merges and never changes a member's readiness: it only talks to the builder.
 */
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { sendGateRedFeedback } from "./gate-red-feedback.js";
import type { TrainMember } from "./merge-train-assembly.js";
import type { TrainRunResult } from "./merge-train.service.js";

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Pure: which members a red train's failing suites implicate. Falls back to all of `members`. */
export function attributeTrainRedToMembers<M extends TrainMember>(failedSuites: readonly string[], members: readonly M[]): M[] {
  const suites = new Set(failedSuites.map(normalizePath).filter(Boolean));
  const owners = members.filter((m) => (m.changedFiles ?? []).some((f) => suites.has(normalizePath(f))));
  return owners.length > 0 ? owners : [...members];
}

export interface TrainRedFeedbackTarget {
  member: TrainMember;
  failedSuites: readonly string[];
}

/** Pure: who gets a turn for this result. Empty when nothing is the builders' to fix. */
export function decideTrainRedFeedbackTargets(result: TrainRunResult, members: readonly TrainMember[]): TrainRedFeedbackTarget[] {
  const targets: TrainRedFeedbackTarget[] = [];
  const seen = new Set<string>();
  for (const r of result.gateRejected) {
    if (!r.failedSuites?.length || seen.has(r.member.workspaceId)) continue;
    seen.add(r.member.workspaceId);
    targets.push({ member: r.member, failedSuites: r.failedSuites });
  }
  // A final-red agent-fix train: nothing landed, nobody was individually rejected, suites named.
  if (result.redStrategy === "agent-fix" && result.landed.length === 0 && result.gateRejected.length === 0 && result.failedSuites?.length) {
    const out = new Set([...result.dropped.map((d) => d.member.workspaceId), ...result.sided.map((s) => s.member.workspaceId)]);
    const aboard = members.filter((m) => !out.has(m.workspaceId));
    for (const member of attributeTrainRedToMembers(result.failedSuites, aboard)) {
      if (seen.has(member.workspaceId)) continue;
      seen.add(member.workspaceId);
      targets.push({ member, failedSuites: result.failedSuites });
    }
  }
  return targets;
}

/** Send each target its one turn. Never throws. */
export async function sendTrainRedFeedback(
  result: TrainRunResult,
  members: readonly TrainMember[],
  deps: { sendTurn: (workspaceId: string, content: string) => Promise<unknown>; headSha: (branch: string) => Promise<string | null> },
): Promise<void> {
  for (const { member, failedSuites } of decideTrainRedFeedbackTargets(result, members)) {
    try {
      const headSha = await deps.headSha(member.branch).catch(() => null);
      await sendGateRedFeedback(
        { workspaceId: member.workspaceId, headSha, failedSuites, guardFailure: false },
        { sendBuilderTurn: deps.sendTurn },
      );
    } catch (err) {
      console.warn(`[merge-train] red-train feedback for ${member.workspaceId} failed: ${errorMessage(err)}`);
    }
  }
}
