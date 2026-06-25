/**
 * Per-project listing of pending (unanswered) AskUserQuestion sets, with
 * staleness computed per card and a compute-on-read response cache.
 */
import type { Database } from "../../db/index.js";
import { readSessionStdoutFileTail } from "../../lib/session-output-reader.js";
import {
  getPendingQuestionWorkspaces,
  getRecentSessionsForWorkspace,
  getSessionStdoutMessages,
  getSyntheticQuestionComments,
} from "../../repositories/agent-questions.repository.js";
import { AGENT_QUESTIONS_CACHE_TTL_MS, pendingQuestionsCache } from "./cache.js";
import { extractQuestionsFromSession, parseSyntheticQuestionPayload } from "./parsing.js";
import { computeStaleness } from "./staleness.js";
import { isAnswered, getCachedRecommendations } from "./markers.js";
import { scheduleBackgroundRecommendation } from "./auto-answer.js";
import type { AutoAnswerSendTurn, PendingQuestionSet } from "./types.js";

/**
 * List pending (unanswered) AskUserQuestion sets across all workspaces of a project.
 * Compute-on-read: scans the most recent completed session per workspace.
 *
 * @param sendTurn  Optional: when provided, newly-computed butler recommendations will
 *                  trigger an auto-answer if the `butler_auto_answer` preference is on.
 */
export async function listPendingQuestionsForProject(
  projectId: string,
  db: Database,
  sendTurn?: AutoAnswerSendTurn,
  nowOverride?: string,
): Promise<PendingQuestionSet[]> {
  // Serve from the per-project response cache when fresh. Skipped when a caller
  // injects its own clock (nowOverride) — deterministic tests need a recompute.
  if (nowOverride === undefined) {
    const cached = pendingQuestionsCache.get(projectId);
    if (cached && cached.db === db && Date.now() - cached.computedAt < AGENT_QUESTIONS_CACHE_TTL_MS) {
      return cached.result;
    }
  }

  // Pull all workspaces+issues for this project (one query). Includes the workspace
  // status/closedAt/readyForMerge and the issue's status-column name so staleness can
  // be computed per card without extra round-trips. Closed workspaces are excluded
  // up front: computeStaleness returns "workspace-merged" for status === "closed"
  // and those results are dropped unconditionally below, so scanning them is
  // provably wasted work (609 of 648 workspaces on the measured project).
  const wsRows = await getPendingQuestionWorkspaces(projectId, db);

  const results: PendingQuestionSet[] = [];
  const now = nowOverride ?? new Date().toISOString();

  for (const ws of wsRows) {
    // Recent sessions (any status), newest first. We scan a few because a question
    // asked in an older session is "superseded" once a newer session has run.
    const sessRows = await getRecentSessionsForWorkspace(ws.workspaceId, db);
    if (sessRows.length === 0) continue;
    const latestSession = sessRows[0];

    // Find the newest non-running session that actually carries pending questions.
    for (const sess of sessRows) {
      // Only questions from the latest session (or sessions tied with its
      // startedAt) can ever surface: anything strictly older is dropped as
      // "superseded" by computeStaleness below. Rows are ordered newest-first,
      // so stop at the first strictly-older session instead of reading its
      // transcript for nothing.
      if (
        sess.startedAt !== null &&
        latestSession.startedAt !== null &&
        latestSession.startedAt > sess.startedAt
      ) break;
      // A running session may not have the result yet.
      if (sess.status === "running") continue;

      // Prefer the .out file for stdout; fall back to DB rows for historical
      // sessions. The file is JSONL — split it into lines so each stream event
      // is parsed individually (the whole file as one string can never
      // JSON.parse, which silently hid questions from file-backed sessions).
      // Only the tail is read: the result event is one of the last lines.
      let msgs: Array<{ type: string; data: string | null }>;
      const fileContent = readSessionStdoutFileTail(sess.id);
      if (fileContent !== null) {
        msgs = fileContent.split("\n").map((line) => ({ type: "stdout", data: line }));
      } else {
        msgs = await getSessionStdoutMessages(sess.id, db);
      }

      const extracted = extractQuestionsFromSession(msgs);
      if (extracted.length === 0) continue;

      for (const { toolUseId, questions } of extracted) {
      if (await isAnswered(toolUseId, db)) continue;
      // Attach cached recommendation (if any) to each question; kick off a background
      // recommend call when not yet cached (and not already in flight).
      const cached = await getCachedRecommendations(toolUseId, db);
      const questionsWithRec = questions.map((q, i) => ({
        ...q,
        recommendation: cached ? (cached[i] ?? null) : undefined,
      }));
      if (!cached) {
        scheduleBackgroundRecommendation(projectId, {
          toolUseId,
          issueId: ws.issueId,
          issueNumber: ws.issueNumber,
          issueTitle: ws.issueTitle,
          issueDescription: ws.issueDescription,
          questions,
        }, db, sendTurn ? { workspaceId: ws.workspaceId, sendTurn } : undefined);
      }
      const staleness = computeStaleness({
        workspaceStatus: ws.workspaceStatus,
        workspaceClosedAt: ws.workspaceClosedAt,
        readyForMerge: ws.readyForMerge,
        issueStatusName: ws.issueStatusName,
        issueCurrentNodeId: ws.issueCurrentNodeId,
        issueCurrentNodeType: ws.issueCurrentNodeType,
        questionSessionStartedAt: sess.startedAt,
        latestSessionStartedAt: latestSession.startedAt,
        askedAt: sess.endedAt,
        now,
      });
      // Drop questions that are definitively stale — workspace closed, issue archived,
      // or a newer session superseded this one. older-than-24h still surfaces (badge only)
      // since the workspace may still be active and the question still actionable.
      if (staleness && staleness.reason !== "older-than-24h") continue;
      results.push({
        toolUseId,
        workspaceId: ws.workspaceId,
        sessionId: sess.id,
        issueId: ws.issueId,
        issueNumber: ws.issueNumber,
        issueTitle: ws.issueTitle,
        questions: questionsWithRec,
        askedAt: sess.endedAt,
        staleness,
      });
      }
      // The newest question-bearing session wins; older ones are superseded copies.
      break;
    }
  }

  // Synthetic (MCP clarify_or_propose) questions live in issue comments. Only
  // kind "agent-question" rows can carry the `mcp_clarify_or_propose` payload
  // (see mcp-server tools/clarify-or-propose.ts), so filter by kind instead of
  // scanning every comment of the project — the unbounded scan grew with the
  // full comment history.
  const syntheticRows = await getSyntheticQuestionComments(projectId, db);

  const seenToolUseIds = new Set(results.map((r) => r.toolUseId));
  for (const row of syntheticRows) {
    if (row.workspaceId === null) continue;
    const parsed = parseSyntheticQuestionPayload(row.payload);
    if (!parsed || seenToolUseIds.has(parsed.toolUseId)) continue;
    if (await isAnswered(parsed.toolUseId, db)) continue;
    results.push({
      toolUseId: parsed.toolUseId,
      workspaceId: row.workspaceId,
      sessionId: `issue-comment:${row.id}`,
      issueId: row.issueId,
      issueNumber: row.issueNumber,
      issueTitle: row.issueTitle,
      questions: parsed.questions,
      askedAt: row.createdAt,
      staleness: null,
    });
    seenToolUseIds.add(parsed.toolUseId);
  }

  if (nowOverride === undefined) {
    pendingQuestionsCache.set(projectId, { db, result: results, computedAt: Date.now() });
  }
  return results;
}
