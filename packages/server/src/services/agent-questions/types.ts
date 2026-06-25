/**
 * Shared types for the agent-questions service family.
 *
 * The Claude harness denies the `AskUserQuestion` tool (sandboxed agents have it
 * disabled). The denial surfaces in the session's terminal `result` event as a
 * `permission_denials[*]` entry whose `tool_input.questions` holds the structured
 * multi-choice questions the agent intended to ask. Without a UI to answer, the
 * agent emits a "Waiting on your answers" message and exits — permanently blocked.
 */

/** Function signature for sending a follow-up turn to a workspace — injected so the
 *  service does not depend on the session manager singleton directly. */
export type AutoAnswerSendTurn = (workspaceId: string, content: string) => Promise<void>;

export interface AgentQuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AgentQuestionOption[];
  /** Butler's recommended answer for this question. Attached server-side when available;
   *  null = recommendation attempted and failed (don't retry); undefined = not yet computed. */
  recommendation?: AgentQuestionRecommendation | null;
}

export interface AgentQuestionRecommendation {
  recommendedOptionIndexes: number[];
  freeText?: string;
  rationale: string;
}

/** Why a pending question is considered stale. `null` when the question is still fresh.
 *  Muted-gray badge in the UI — not an error, just a hint the answer may no longer matter. */
export type StalenessReason =
  | "workspace-merged"
  | "issue-done"
  | "superseded"
  | "older-than-24h";

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
  /** Set when the question is likely no longer actionable; null when fresh. */
  staleness: Staleness | null;
}

export interface StalenessInput {
  /** workspace.status — "closed" means merged/closed. */
  workspaceStatus: string;
  /** workspace.closedAt, if any. */
  workspaceClosedAt: string | null;
  /** workspace.readyForMerge flag. */
  readyForMerge: boolean;
  /** Name of the issue's current status column. */
  issueStatusName: string | null;
  /** Current workflow node, when the issue is workflow-driven. */
  issueCurrentNodeId?: string | null;
  issueCurrentNodeType?: string | null;
  /** Start time of the session that produced the question. */
  questionSessionStartedAt: string | null;
  /** Start time of the newest session for the workspace (may equal the question's). */
  latestSessionStartedAt: string | null;
  /** When the question was asked (session.endedAt). */
  askedAt: string | null;
  /** Current time, ISO string — passed in so the function stays free of Date.now(). */
  now: string;
}

/** Per-question recommendation input shared by the recommender and auto-answer paths. */
export interface RecommendInput {
  toolUseId: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  issueDescription: string | null;
  questions: AgentQuestion[];
}
