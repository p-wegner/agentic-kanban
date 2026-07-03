/**
 * Resolution markers for AskUserQuestion asks — answered / dismissed prefs, the
 * durable `agent-question` ticket comment, and cached butler recommendations.
 *
 * Tracks per-`tool_use_id` state in the preferences table so resolved questions
 * stop appearing in the pending list.
 */
import type { Database } from "../../db/index.js";
import { getRuntimeState, setRuntimeState } from "../../repositories/runtime-state.repository.js";
import { AGENT_QUESTION_MARKER_TTL_MS } from "../../lib/runtime-state-keys.js";
import { insertIssueComment } from "../../repositories/issue-comments.repository.js";
import { getWorkspaceIssueId } from "../../repositories/agent-questions.repository.js";
import { invalidateAgentQuestionsCache } from "./cache.js";
import type { AgentQuestion, AgentQuestionRecommendation } from "./types.js";

/** Runtime-state keys (kept out of the `preferences` config table, #975). The
 *  namespace prefixes are catalogued in `lib/runtime-state-keys.ts`. */
function answeredStateKey(toolUseId: string): string {
  return `agent_question_answered_${toolUseId}`;
}

function recommendationStateKey(toolUseId: string): string {
  return `agent_question_recommendation_${toolUseId}`;
}

/** Returns true if this AskUserQuestion ask has been resolved — either answered (and
 *  re-sent) or dismissed. Both write the same `agent_question_answered_<id>` pref, so a
 *  resolved question stops appearing in the pending list. The legacy value is the literal
 *  string "1"; dismissals store a JSON object `{ dismissed: true, dismissedAt }`. */
export async function isAnswered(toolUseId: string, db: Database): Promise<boolean> {
  return (await getRuntimeState(answeredStateKey(toolUseId), db)) !== null;
}

export async function markAnswered(toolUseId: string, db: Database): Promise<void> {
  await setRuntimeState(answeredStateKey(toolUseId), "1", db, { ttlMs: AGENT_QUESTION_MARKER_TTL_MS });
  invalidateAgentQuestionsCache();
}

/**
 * Persist an answered AskUserQuestion as a durable `agent-question` comment on the
 * ticket, so the clarification becomes part of the issue's visible history (not just
 * an opaque answered-pref marker). Resolves the issueId from the workspace. Best-effort:
 * a failure here must never block the answer turn that already went through.
 *
 * @param author  "user" for a manual answer, "butler" for an auto-answer.
 */
export async function writeAgentQuestionComment(
  params: {
    toolUseId: string;
    workspaceId: string;
    questions: AgentQuestion[];
    answers: { selectedLabels: string[]; freeText?: string }[];
    body: string;
    author: "user" | "butler";
  },
  db: Database,
): Promise<void> {
  try {
    const issueId = await getWorkspaceIssueId(params.workspaceId, db);
    if (!issueId) return;
    await insertIssueComment(
      {
        issueId,
        workspaceId: params.workspaceId,
        kind: "agent-question",
        author: params.author,
        body: params.body,
        payload: { toolUseId: params.toolUseId, questions: params.questions, answers: params.answers },
      },
      db,
    );
  } catch (err) {
    console.error(`[agent-questions] failed to write agent-question comment: toolUseId=${params.toolUseId} ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Mark a pending question dismissed by the user. The corresponding workspace is NOT
 *  relaunched or notified — the row is kept (not deleted) for audit. Stores
 *  `{ dismissed: true, dismissedAt }` under the same answered pref key so the question
 *  disappears from the pending list. `dismissedAt` is passed in (callers stamp the time)
 *  so the service stays free of `Date.now()`/`new Date()`. */
export async function markDismissed(toolUseId: string, dismissedAt: string, db: Database): Promise<void> {
  await setRuntimeState(answeredStateKey(toolUseId), JSON.stringify({ dismissed: true, dismissedAt }), db, {
    ttlMs: AGENT_QUESTION_MARKER_TTL_MS,
  });
  invalidateAgentQuestionsCache();
}

/** Cached recommendation array, one entry per sub-question. A null entry = couldn't recommend
 *  (e.g. butler returned malformed JSON); the *outer* return is null = not yet computed. */
export async function getCachedRecommendations(
  toolUseId: string,
  db: Database,
): Promise<Array<AgentQuestionRecommendation | null> | null> {
  const raw = await getRuntimeState(recommendationStateKey(toolUseId), db);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { recommendations?: Array<AgentQuestionRecommendation | null> };
    if (!Array.isArray(parsed.recommendations)) return null;
    return parsed.recommendations;
  } catch {
    return null;
  }
}

export async function setCachedRecommendations(
  toolUseId: string,
  recommendations: Array<AgentQuestionRecommendation | null>,
  db: Database,
): Promise<void> {
  await setRuntimeState(recommendationStateKey(toolUseId), JSON.stringify({ recommendations }), db, {
    ttlMs: AGENT_QUESTION_MARKER_TTL_MS,
  });
  // A landed recommendation changes the `recommendation` field attached to the
  // cached listing — drop the response cache so the next poll picks it up.
  invalidateAgentQuestionsCache();
}
