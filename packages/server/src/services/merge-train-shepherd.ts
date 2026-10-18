/**
 * The TRAIN SHEPHERD (#1569): ONE persistent agent per merge train that owns making the train
 * mergeable. It resolves member-vs-member merge conflicts as members join, and (through
 * `runAgentFix`'s runner port) fixes the train gate when it goes red. Every turn goes to the SAME
 * session, so its context and prompt cache already hold the tickets in the tree.
 *
 * This module is pure orchestration over ports (`tryMerge`, `isResolved`, the runner), so it is
 * testable without git, a gate or an agent. PHASE 1: nothing calls `mergeMembersWithShepherd` from
 * `assembleMergeTrain` yet - see CONTINUE.md for the remaining wiring.
 */
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { MergeTrainAgentFixCaps } from "@agentic-kanban/shared/lib/merge-train-red-strategy";
import { describeMemberForBrief, isInfraFailure, SHEPHERD_MAX_INFRA_RETRIES, type AgentFixMember, type TrainAgentRunner } from "./merge-train-agent-fix.js";

export type ShepherdAction = "idle" | `resolving conflict ${string}` | "fixing gate";

/** What the train row / `status --watch` shows about the shepherd. */
export interface ShepherdStatus {
  sessionId?: string;
  worker?: string;
  turnsUsed: number;
  infraRetries: number;
  lastAction: ShepherdAction;
}

/**
 * Wraps a runner so every turn resumes the shepherd's session and records what it did. A thrown
 * turn (worker disconnect, launch failure) is NOT counted: `turnsUsed` moves on success only.
 */
export class TrainShepherd {
  sessionId?: string;
  worker?: string;
  turnsUsed = 0;
  infraRetries = 0;
  lastAction: ShepherdAction = "idle";
  private started = false;

  constructor(private readonly inner: TrainAgentRunner, workerName?: string) {
    this.worker = workerName;
  }

  /** True until the first turn has run: the next brief must carry the full member context. */
  get needsFullBrief(): boolean { return !this.started; }

  readonly runner: TrainAgentRunner = async (args) => {
    const run = await this.inner({ ...args, ...(this.sessionId ? { resumeSessionId: this.sessionId } : {}) });
    this.sessionId = run.sessionId ?? this.sessionId;
    this.turnsUsed++;
    this.started = true;
    return run;
  };

  setAction(action: ShepherdAction): void { this.lastAction = action; }

  status(): ShepherdStatus {
    return {
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.worker ? { worker: this.worker } : {}),
      turnsUsed: this.turnsUsed, infraRetries: this.infraRetries, lastAction: this.lastAction,
    };
  }
}

export interface ShepherdMember extends AgentFixMember {
  /** The other member this one collides with, when known (for the brief and the action line). */
  conflictsWith?: AgentFixMember;
}

export type MergeAttempt = { ok: true } | { ok: false; detail: string; conflictsWith?: AgentFixMember };

/** Pure: the brief for ONE conflict turn. The first turn carries the tree context; later turns only the new member. */
export function buildConflictBrief(args: {
  label: string;
  baseBranch: string;
  member: ShepherdMember;
  alreadyOnTrain: readonly AgentFixMember[];
  detail: string;
  first: boolean;
}): string {
  const rival = args.member.conflictsWith;
  return [
    args.first
      ? `# You are the shepherd of merge train ${args.label}`
      : `# Merge train ${args.label}: another member conflicts`,
    "",
    ...(args.first ? [
      `The working directory is the train tree: member branches merged onto \`${args.baseBranch}\` with --no-ff.`,
      "You own making this train mergeable: resolve merge conflicts as members join, and later fix the gate if it goes red.",
      "",
      "## Already on the train",
      args.alreadyOnTrain.length > 0 ? args.alreadyOnTrain.map(describeMemberForBrief).join("\n") : "- (nothing yet)",
      "",
    ] : []),
    "## Member to merge (conflicting)",
    describeMemberForBrief(args.member),
    ...(rival ? ["", `It collides with ${rival.issueNumber != null ? `#${rival.issueNumber}` : rival.branch}.`] : []),
    "",
    "## Merge output",
    "```",
    args.detail.split(/\r?\n/).slice(-40).join("\n").slice(-4000),
    "```",
    "",
    "## Scope",
    `- A merge of \`${args.member.branch}\` is in progress in this directory. Resolve every conflict keeping BOTH members' intent.`,
    "- Complete the merge with a plain commit (no rebase, no squash). Work only in this directory.",
  ].join("\n");
}

export interface ConflictAssemblyResult {
  included: ShepherdMember[];
  /** Left out, with the logged reason; `deferred` members wait for the next train (the fallback only). */
  dropped: Array<{ member: ShepherdMember; reason: string; deferred: true }>;
  /** True when infrastructure failures exhausted the retries: the train is inconclusive, not red. */
  held: boolean;
}

/**
 * Merge `members` onto the train one by one. A clean merge joins directly; a conflict goes to the
 * shepherd (the same session every time). Deferral to the next train is the fallback only, for a
 * shepherd that is capped, could not resolve, or could not be placed - and it is logged with why.
 */
export async function mergeMembersWithShepherd(args: {
  label: string;
  baseBranch: string;
  worktree: string;
  members: readonly ShepherdMember[];
  shepherd: TrainShepherd;
  caps: MergeTrainAgentFixCaps;
  /** Attempt `git merge --no-ff` of the member onto the train worktree; leaves the merge IN PROGRESS on conflict. */
  tryMerge: (member: ShepherdMember) => Promise<MergeAttempt>;
  /** Did the shepherd complete the merge (committed, member tip an ancestor, no markers left)? */
  isResolved: (member: ShepherdMember) => Promise<boolean>;
  /** Back out an unresolved merge so the tree is clean for the next member. */
  abortMerge: () => Promise<void>;
  log?: (line: string) => void;
  nowMs?: () => number;
}): Promise<ConflictAssemblyResult> {
  const { shepherd, caps } = args;
  const log = args.log ?? ((line: string) => console.warn(`[merge-train] ${line}`));
  const nowMs = args.nowMs ?? (() => Date.now());
  const startedMs = nowMs();
  const included: ShepherdMember[] = [];
  const dropped: ConflictAssemblyResult["dropped"] = [];
  let held = false;

  const defer = async (member: ShepherdMember, reason: string) => {
    await args.abortMerge().catch(() => undefined);
    dropped.push({ member, reason: `${reason} - deferred to the next train`, deferred: true });
    log(`${args.label}: shepherd fallback - deferring ${member.branch}${member.issueNumber != null ? ` (#${member.issueNumber})` : ""}: ${reason}`);
  };

  for (const member of args.members) {
    const attempt = await args.tryMerge(member).catch((err): MergeAttempt => ({ ok: false, detail: errorMessage(err) }));
    if (attempt.ok) { included.push(member); continue; }
    const m: ShepherdMember = { ...member, ...(attempt.conflictsWith ? { conflictsWith: attempt.conflictsWith } : {}) };
    if (held) { await defer(m, "shepherd unavailable (infrastructure)"); continue; }
    if (shepherd.turnsUsed >= caps.maxTurns) { await defer(m, `shepherd turn cap ${caps.maxTurns} reached`); continue; }
    const remaining = caps.timeoutMs - (nowMs() - startedMs);
    if (remaining <= 0) { await defer(m, `shepherd timeout ${caps.timeoutMs}ms reached`); continue; }

    const rivalId = m.conflictsWith?.issueNumber != null ? `#${m.conflictsWith.issueNumber}` : m.conflictsWith?.branch ?? "the train";
    shepherd.setAction(`resolving conflict ${m.issueNumber != null ? `#${m.issueNumber}` : m.branch} vs ${rivalId}`);
    const prompt = buildConflictBrief({
      label: args.label, baseBranch: args.baseBranch, member: m, alreadyOnTrain: included,
      detail: attempt.detail, first: shepherd.needsFullBrief,
    });
    let ran = false;
    let lastError = "";
    while (!ran && shepherd.infraRetries <= SHEPHERD_MAX_INFRA_RETRIES) {
      try {
        await shepherd.runner({ worktree: args.worktree, prompt, timeoutMs: remaining, turn: shepherd.turnsUsed + 1 });
        ran = true;
      } catch (err) {
        lastError = errorMessage(err).slice(0, 300);
        if (!isInfraFailure(lastError)) break;
        shepherd.infraRetries++;
      }
    }
    shepherd.setAction("idle");
    if (!ran) {
      if (isInfraFailure(lastError)) { held = true; await defer(m, `shepherd could not be placed: ${lastError}`); }
      else await defer(m, `shepherd failed: ${lastError}`);
      continue;
    }
    if (await args.isResolved(m).catch(() => false)) included.push(m);
    else await defer(m, "shepherd did not resolve the conflict");
  }
  return { included, dropped, held };
}
