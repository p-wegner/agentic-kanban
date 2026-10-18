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
import type { MergeTrainShepherdDto } from "@agentic-kanban/shared/types";
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
  tokens: number;
  costUsd: number;
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
  tokens = 0;
  costUsd = 0;
  /** #1572: every conflict handed to the shepherd and what became of it (persisted with the train). */
  readonly conflicts: NonNullable<MergeTrainShepherdDto["conflicts"]> = [];
  private started = false;

  /** `onChange` fires after every turn / action / conflict outcome so the caller can persist a live status. */
  constructor(private readonly inner: TrainAgentRunner, workerName?: string, private readonly onChange?: (status: MergeTrainShepherdDto) => void) {
    this.worker = workerName;
  }

  /** True until the first turn has run: the next brief must carry the full member context. */
  get needsFullBrief(): boolean { return !this.started; }

  readonly runner: TrainAgentRunner = async (args) => {
    const run = await this.inner({ ...args, ...(this.sessionId ? { resumeSessionId: this.sessionId } : {}) });
    this.sessionId = run.sessionId ?? this.sessionId;
    this.worker = run.worker ?? this.worker;
    this.tokens += run.tokens ?? 0;
    this.costUsd += run.costUsd ?? 0;
    this.turnsUsed++;
    this.started = true;
    this.changed();
    return run;
  };

  setAction(action: ShepherdAction): void { this.lastAction = action; this.changed(); }

  recordConflict(workspaceId: string, outcome: "resolved" | "deferred", reason?: string): void {
    this.conflicts.push({ workspaceId, outcome, ...(reason ? { reason: reason.slice(0, 200) } : {}) });
    this.changed();
  }

  /** The persisted/wire shape of the shepherd right now. */
  toDto(): MergeTrainShepherdDto {
    return {
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.worker ? { worker: this.worker } : {}),
      turns: this.turnsUsed,
      ...(this.infraRetries > 0 ? { infraRetries: this.infraRetries } : {}),
      lastAction: this.lastAction,
      ...(this.tokens > 0 ? { tokens: this.tokens } : {}),
      ...(this.costUsd > 0 ? { costUsd: Number(this.costUsd.toFixed(4)) } : {}),
      ...(this.conflicts.length > 0 ? { conflicts: [...this.conflicts] } : {}),
    };
  }

  private changed(): void {
    try { this.onChange?.(this.toDto()); } catch { /* progress reporting never fails a train */ }
  }

  status(): ShepherdStatus {
    return {
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.worker ? { worker: this.worker } : {}),
      turnsUsed: this.turnsUsed, infraRetries: this.infraRetries, lastAction: this.lastAction,
      tokens: this.tokens, costUsd: this.costUsd,
    };
  }
}

export interface ShepherdMember extends AgentFixMember {
  /** The other member this one collides with, when known (for the brief and the action line). */
  conflictsWith?: AgentFixMember;
}

export type MergeAttempt =
  | { ok: true }
  // `unresolvable`: not the shepherd's to fix (a conflict with the BASE itself, an unknown branch) - dropped, never deferred.
  | { ok: false; detail: string; conflictsWith?: AgentFixMember; unresolvable?: true };

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
  dropped: Array<{ member: ShepherdMember; reason: string; deferred: boolean }>;
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
  /** #1431: where a turn may be placed (a worker edits a checkout of the train tree). */
  placement?: { projectId: string; repoPath: string };
  /** Attempt `git merge --no-ff` of the member onto the train worktree; leaves the merge IN PROGRESS on conflict. */
  tryMerge: (member: ShepherdMember) => Promise<MergeAttempt>;
  /** Did the shepherd complete the merge (committed, member tip an ancestor, no markers left)? */
  isResolved: (member: ShepherdMember) => Promise<boolean>;
  /** Back out an unresolved merge so the tree is clean for the next member. */
  abortMerge: () => Promise<void>;
  log?: (line: string) => void;
}): Promise<ConflictAssemblyResult> {
  const { shepherd, caps } = args;
  const log = args.log ?? ((line: string) => console.warn(`[merge-train] ${line}`));
  const startedMs = Date.now();
  const included: ShepherdMember[] = [];
  const dropped: ConflictAssemblyResult["dropped"] = [];
  let held = false;

  const defer = async (member: ShepherdMember, reason: string) => {
    await args.abortMerge().catch(() => undefined);
    shepherd.recordConflict(member.workspaceId, "deferred", reason);
    dropped.push({ member, reason: `${reason} - deferred to the next train`, deferred: true });
    log(`${args.label}: shepherd fallback - deferring ${member.branch}${member.issueNumber != null ? ` (#${member.issueNumber})` : ""}: ${reason}`);
  };

  for (const member of args.members) {
    const attempt = await args.tryMerge(member).catch((err): MergeAttempt => ({ ok: false, detail: errorMessage(err) }));
    if (attempt.ok) { included.push(member); continue; }
    if (attempt.unresolvable) {
      await args.abortMerge().catch(() => undefined);
      dropped.push({ member, reason: attempt.detail.slice(0, 300), deferred: false });
      log(`${args.label}: dropping ${member.branch}${member.issueNumber != null ? ` (#${member.issueNumber})` : ""}: ${attempt.detail.slice(0, 120)}`);
      continue;
    }
    const m: ShepherdMember = { ...member, ...(attempt.conflictsWith ? { conflictsWith: attempt.conflictsWith } : {}) };
    if (held) { await defer(m, "shepherd unavailable (infrastructure)"); continue; }
    if (shepherd.turnsUsed >= caps.maxTurns) { await defer(m, `shepherd turn cap ${caps.maxTurns} reached`); continue; }
    if (shepherd.costUsd > caps.costCapUsd) { await defer(m, `shepherd cost $${shepherd.costUsd.toFixed(2)} passed the $${caps.costCapUsd} cap`); continue; }
    const remaining = caps.timeoutMs - (Date.now() - startedMs);
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
        await shepherd.runner({ worktree: args.worktree, prompt, timeoutMs: remaining, turn: shepherd.turnsUsed + 1, ...(args.placement ? { ...args.placement, baseBranch: args.baseBranch } : {}) });
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
    if (await args.isResolved(m).catch(() => false)) { included.push(m); shepherd.recordConflict(m.workspaceId, "resolved"); }
    else await defer(m, "shepherd did not resolve the conflict");
  }
  return { included, dropped, held };
}
