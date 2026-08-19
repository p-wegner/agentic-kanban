/**
 * Agent-questions wire types (#569).
 *
 * The Claude harness denies the `AskUserQuestion` tool for sandboxed agents; the denial
 * surfaces in the session's terminal `result` event, and the board renders the questions
 * so a human can answer them. Six types described that payload — and they were declared
 * TWICE, in `server/src/services/agent-questions/types.ts` and again in
 * `client/src/components/AgentQuestionsPanel.tsx`, with `staleness` required on one side
 * and optional on the other. The client's own store imported them FROM the component,
 * which is how a UI file ended up owning a wire contract.
 */

export interface AgentQuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestionRecommendation {
  recommendedOptionIndexes: number[];
  freeText?: string;
  rationale: string;
}

export interface AgentQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AgentQuestionOption[];
  /** Butler's recommended answer. Attached server-side when available;
   *  null = attempted and failed (don't retry); undefined = not yet computed. */
  recommendation?: AgentQuestionRecommendation | null;
}

/** Why a pending question is considered stale. `null` when the question is still fresh. */
export type StalenessReason = "workspace-merged" | "issue-done" | "superseded" | "older-than-24h";

export interface Staleness {
  reason: StalenessReason;
  /** Human-readable label for the badge, e.g. "stale — workspace merged". */
  label: string;
  /** Relevant timestamp for the tooltip (workspace.closedAt, newer session start, or askedAt). */
  at: string | null;
}

export interface PendingQuestionSet {
  /** The `tool_use_id` from the denied AskUserQuestion call — unique per ask. */
  toolUseId: string;
  workspaceId: string;
  sessionId: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  questions: AgentQuestion[];
  /** When the session ended (session.endedAt). */
  askedAt: string | null;
  /**
   * Set when the question is likely no longer actionable; null when fresh.
   *
   * Required, not optional: the server always sends the field. The client's copy had it
   * optional, so client code guarded a case the server never produces.
   */
  staleness: Staleness | null;
}
