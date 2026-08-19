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
import type {
  AgentQuestionOption,
  AgentQuestion,
  AgentQuestionRecommendation,
  StalenessReason,
  Staleness,
  PendingQuestionSet,
} from "@agentic-kanban/shared/types";

export type AutoAnswerSendTurn = (workspaceId: string, content: string) => Promise<void>;

// The six wire types moved to shared (#569); the client had its own drifted copy.
export type {
  AgentQuestionOption,
  AgentQuestion,
  AgentQuestionRecommendation,
  StalenessReason,
  Staleness,
  PendingQuestionSet,
};

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
