/**
 * Wires ONE train shepherd (#1572) into a train job: the same persistent agent resolves member
 * conflicts during incremental assembly and fixes the red gate afterwards, through one shared
 * runner, so the second conflict and the red gate resume the first turn's session.
 *
 * Extracted from `merge-queue-train.ts` (at the god-module ceiling). The shepherd only works on the
 * whole train's attempt (`attemptLabel === label`); a bisect half is already a search.
 */
import type { MergeTrainShepherdDto } from "@agentic-kanban/shared/types";
import type { MergeTrainRedPolicy } from "@agentic-kanban/shared/lib/merge-train-red-strategy";
import type { Database } from "../db/index.js";
import { recordMergeTrainShepherd } from "../repositories/merge-train.repository.js";
import type { BoardEventSink } from "./board-events.js";
import { describeAgentFixFinished, enrichMembersWithTickets, runAgentFix, type AgentFixOutcome, type AgentFixGateVerdict, type TrainAgentRunner } from "./merge-train-agent-fix.js";
import { assembleMergeTrain, type TrainMember } from "./merge-train-assembly.js";
import { assembleMergeTrainWithShepherd, type ShepherdAssemblyMember } from "./merge-train-incremental-assembly.js";
import { TrainShepherd } from "./merge-train-shepherd.js";
import { looksLikeMissingDepsFailure } from "./pre-merge-gate.service.js";

type AssembleArgs = { repoPath: string; baseBranch: string; members: TrainMember[]; label: string };

export interface TrainShepherdKit {
  shepherd: TrainShepherd;
  /** Passed to `runMergeTrain({ assemble })`: the whole train resolves conflicts, bisect halves assemble as before. */
  assemble: (args: AssembleArgs) => ReturnType<typeof assembleMergeTrain>;
  /** Resolves when every queued live-status write has landed; await it before the train's final evidence write. */
  flush: () => Promise<void>;
  /** The status to persist once more after the final evidence write, or undefined when the shepherd never ran. */
  finalStatus: () => MergeTrainShepherdDto | undefined;
}

export function createTrainShepherdKit(args: {
  database: Database;
  agentRunner: TrainAgentRunner;
  policy: MergeTrainRedPolicy;
  trainId: string;
  projectId: string;
  label: string;
  members: ReadonlyArray<TrainMember & { issueId?: string }>;
  boardEvents?: BoardEventSink;
}): TrainShepherdKit {
  const { database, policy, trainId, projectId, label } = args;
  let writes: Promise<void> = Promise.resolve();
  const shepherd = new TrainShepherd(args.agentRunner, undefined, (status) => {
    // Serialised: two overlapping read-modify-writes of the evidence column would lose one.
    writes = writes
      .then(() => recordMergeTrainShepherd(trainId, { ...status }, database))
      .then(() => args.boardEvents?.broadcast(projectId, "merge_train_changed"))
      .catch(() => undefined);
  });
  const full = new Map(args.members.map((m) => [m.workspaceId, m]));
  return {
    shepherd,
    assemble: (a) => {
      if (!policy.agentFix || a.label !== label) return assembleMergeTrain(a);
      const members = a.members.map((m): ShepherdAssemblyMember => ({ ...m, ...(full.get(m.workspaceId)?.issueId ? { issueId: full.get(m.workspaceId)!.issueId } : {}) }));
      return assembleMergeTrainWithShepherd({ ...a, members }, { database, shepherd, caps: policy.caps, placement: { projectId, repoPath: a.repoPath } });
    },
    flush: () => writes,
    finalStatus: () => (shepherd.turnsUsed > 0 || shepherd.conflicts.length > 0 ? shepherd.toDto() : undefined),
  };
}

/**
 * #1277 — the fix-agent hook for ONE attempt's staging gate, or undefined when this attempt gets
 * none. Only the WHOLE train's gate (`attemptLabel === label`) is ever fixed: a bisect half is
 * already a search, and the fix agent is the alternative to starting one. A missing-dependency red
 * is the staging worktree's environment (#1154), which no code edit repairs. #1572: the turns go
 * through the shared shepherd runner, so they resume the session that resolved the conflicts.
 */
export function buildTrainOnRed(args: {
  policy: MergeTrainRedPolicy;
  shepherd: TrainShepherd;
  label: string;
  attemptLabel: string;
  baseBranch: string;
  included: ReadonlyArray<{ workspaceId: string }>;
  members: ReadonlyArray<{ workspaceId: string; branch: string; issueNumber?: number | null; issueId?: string; changedFiles?: readonly string[] }>;
  database: Database;
  /** #1431: where the fix agent's turn may be placed (a worker edits a checkout of the train tree). */
  placement: { projectId: string; repoPath: string };
}): ((ctx: { gateWorktree: string; message: string; failedSuites?: string[]; regate: () => Promise<AgentFixGateVerdict> }) => Promise<AgentFixOutcome | null>) | undefined {
  const { policy, label, attemptLabel, shepherd } = args;
  if (!policy.agentFix || attemptLabel !== label) return undefined;
  const aboard = args.included.flatMap((m) => args.members.filter((x) => x.workspaceId === m.workspaceId));
  return async ({ gateWorktree, message, failedSuites, regate }) => {
    // #1573: a retry that still names failing suites is a real red, whatever the message says.
    if (looksLikeMissingDepsFailure(message) && !failedSuites?.length) return null;
    console.log(`[merge-train] ${label}: gate RED - spawning the fix agent in ${gateWorktree} (strategy ${policy.strategy}, timeout ${policy.caps.timeoutMs}ms, ${policy.caps.maxTurns} turn(s))`);
    shepherd.setAction("fixing gate");
    try {
      const outcome = await runAgentFix({
        worktree: gateWorktree, label, baseBranch: args.baseBranch, members: await enrichMembersWithTickets(aboard, args.database),
        initialFailure: { message, failedSuites }, caps: policy.caps, runAgent: shepherd.runner, regate, placement: args.placement,
        membersAlreadySent: () => !shepherd.needsFullBrief, priorCostUsd: shepherd.costUsd,
      });
      console.log(`[merge-train] ${describeAgentFixFinished(label, outcome, policy.bisectAfter)}`);
      return outcome;
    } finally {
      shepherd.setAction("idle");
    }
  };
}
