/**
 * Per-project listing of pending (unanswered) AskUserQuestion sets, with
 * staleness computed per card and a compute-on-read response cache.
 */
import type { Database } from "../../db/index.js";
import { readSessionStdoutFileTailAsync } from "../../lib/session-output-reader.js";
import {
  getPendingQuestionWorkspaces,
  getRecentSessionsForWorkspace,
  getSessionStdoutMessages,
  getSyntheticQuestionComments,
  type PendingQuestionWorkspaceRow,
} from "../../repositories/agent-questions.repository.js";
import { getIssueDescription } from "../../repositories/issue.repository.js";
import { AGENT_QUESTIONS_CACHE_TTL_MS, pendingQuestionsCache } from "./cache.js";
import { extractQuestionsFromSession, parseSyntheticQuestionPayload } from "./parsing.js";
import { computeStaleness } from "./staleness.js";
import { getAnsweredToolUseIds, getCachedRecommendationsMany } from "./markers.js";
import { scheduleBackgroundRecommendation } from "./auto-answer.js";
import type { AutoAnswerSendTurn, PendingQuestionSet } from "./types.js";

/** One question-bearing session found for a workspace (phase 1 of the listing). */
interface WorkspaceCandidate {
  ws: PendingQuestionWorkspaceRow;
  sessionId: string;
  sessionStartedAt: string | null;
  sessionEndedAt: string | null;
  latestSessionStartedAt: string | null;
  extracted: ReturnType<typeof extractQuestionsFromSession>;
}

/**
 * List pending (unanswered) AskUserQuestion sets across all workspaces of a project.
 * Compute-on-read: scans the most recent completed session per workspace.
 *
 * Structure (#418): phase 1 collects the candidate question sets (transcript
 * scans), then the answered-markers and cached recommendations for ALL candidates
 * are read in single batched queries — the per-question runtime_state lookups were
 * an N+1 on every inbox/bell poll.
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

  const now = nowOverride ?? new Date().toISOString();

  // ── Phase 1: find each workspace's newest question-bearing session ──────────
  const candidates: WorkspaceCandidate[] = [];
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
      // Only the tail is read: the result event is one of the last lines. Async
      // reader (#401): the sync twin's docstring forbids server hot paths, and this
      // listing runs on every inbox/bell/questions poll (G3, 2026-08-11 audit).
      let msgs: Array<{ type: string; data: string | null }>;
      const fileContent = await readSessionStdoutFileTailAsync(sess.id);
      if (fileContent !== null) {
        msgs = fileContent.split("\n").map((line) => ({ type: "stdout", data: line }));
      } else {
        msgs = await getSessionStdoutMessages(sess.id, db);
      }

      const extracted = extractQuestionsFromSession(msgs);
      if (extracted.length === 0) continue;

      candidates.push({
        ws,
        sessionId: sess.id,
        sessionStartedAt: sess.startedAt,
        sessionEndedAt: sess.endedAt,
        latestSessionStartedAt: latestSession.startedAt,
        extracted,
      });
      // The newest question-bearing session wins; older ones are superseded copies.
      break;
    }
  }

  // Synthetic (MCP clarify_or_propose) questions live in issue comments. Only
  // kind "agent-question" rows can carry the `mcp_clarify_or_propose` payload
  // (see mcp-server tools/clarify-or-propose.ts), so filter by kind — and the
  // repository bounds the scan (created_at floor + LIMIT, #418) so it does not
  // grow with the project's full comment history.
  const syntheticRows = await getSyntheticQuestionComments(projectId, db, { now });
  const parsedSynthetic = syntheticRows
    .filter((row) => row.workspaceId !== null)
    .map((row) => ({ row, parsed: parseSyntheticQuestionPayload(row.payload) }))
    .filter((s): s is typeof s & { parsed: NonNullable<typeof s.parsed> } => s.parsed !== null);

  // ── Phase 2: batched marker/recommendation reads (one IN query each) ────────
  const allToolUseIds = [
    ...candidates.flatMap((cand) => cand.extracted.map((e) => e.toolUseId)),
    ...parsedSynthetic.map((s) => s.parsed.toolUseId),
  ];
  const answeredIds = await getAnsweredToolUseIds(allToolUseIds, db);
  const cachedRecs = await getCachedRecommendationsMany(
    candidates.flatMap((cand) => cand.extracted.map((e) => e.toolUseId)),
    db,
  );

  // Lazily-fetched issue descriptions, only for the rare uncached-recommendation
  // branch (#418: the workspace scan no longer drags every open issue's
  // description through the poll). Memoized per issue within this compute.
  const descriptionByIssue = new Map<string, string | null>();
  async function issueDescriptionFor(issueId: string): Promise<string | null> {
    if (descriptionByIssue.has(issueId)) return descriptionByIssue.get(issueId) ?? null;
    const issue = await getIssueDescription(issueId, db).catch(() => null);
    const description = issue?.description ?? null;
    descriptionByIssue.set(issueId, description);
    return description;
  }

  const results: PendingQuestionSet[] = [];
  for (const cand of candidates) {
    const { ws } = cand;
    for (const { toolUseId, questions } of cand.extracted) {
      if (answeredIds.has(toolUseId)) continue;
      // Attach cached recommendation (if any) to each question; kick off a background
      // recommend call when not yet cached (and not already in flight).
      const cached = cachedRecs.get(toolUseId) ?? null;
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
          issueDescription: await issueDescriptionFor(ws.issueId),
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
        questionSessionStartedAt: cand.sessionStartedAt,
        latestSessionStartedAt: cand.latestSessionStartedAt,
        askedAt: cand.sessionEndedAt,
        now,
      });
      // Drop questions that are definitively stale — workspace closed, issue archived,
      // or a newer session superseded this one. older-than-24h still surfaces (badge only)
      // since the workspace may still be active and the question still actionable.
      if (staleness && staleness.reason !== "older-than-24h") continue;
      results.push({
        toolUseId,
        workspaceId: ws.workspaceId,
        sessionId: cand.sessionId,
        issueId: ws.issueId,
        issueNumber: ws.issueNumber,
        issueTitle: ws.issueTitle,
        questions: questionsWithRec,
        askedAt: cand.sessionEndedAt,
        staleness,
      });
    }
  }

  const seenToolUseIds = new Set(results.map((r) => r.toolUseId));
  for (const { row, parsed } of parsedSynthetic) {
    if (seenToolUseIds.has(parsed.toolUseId)) continue;
    if (answeredIds.has(parsed.toolUseId)) continue;
    results.push({
      toolUseId: parsed.toolUseId,
      workspaceId: row.workspaceId as string,
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
