/**
 * AskUserQuestion parser + per-project listing service.
 *
 * The Claude harness denies the `AskUserQuestion` tool (sandboxed agents have it
 * disabled). The denial surfaces in the session's terminal `result` event as a
 * `permission_denials[*]` entry whose `tool_input.questions` holds the structured
 * multi-choice questions the agent intended to ask. Without a UI to answer, the
 * agent emits a "Waiting on your answers" message and exits — permanently blocked.
 *
 * This service scans completed sessions for those denials, returns the questions
 * as structured records, and tracks per-`tool_use_id` "answered" markers in the
 * preferences table so answered questions stop appearing.
 */
import { sessions, sessionMessages, workspaces, issues } from "@agentic-kanban/shared/schema";
import { eq, and, desc } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";

export interface AgentQuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AgentQuestionOption[];
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
}

function answeredPrefKey(toolUseId: string): string {
  return `agent_question_answered_${toolUseId}`;
}

/** Returns true if this AskUserQuestion ask has already been answered (and re-sent). */
export async function isAnswered(toolUseId: string, db: Database): Promise<boolean> {
  return (await getPreference(answeredPrefKey(toolUseId), db)) === "1";
}

export async function markAnswered(toolUseId: string, db: Database): Promise<void> {
  await setPreference(answeredPrefKey(toolUseId), "1", db);
}

/**
 * Parse the last `result` stdout event for AskUserQuestion permission denials and
 * return their structured questions. Returns [] if none.
 */
export function extractQuestionsFromSession(
  messages: { type: string; data?: string | null }[],
): { toolUseId: string; questions: AgentQuestion[] }[] {
  const out: { toolUseId: string; questions: AgentQuestion[] }[] = [];
  for (const msg of messages) {
    if (msg.type !== "stdout" || !msg.data) continue;
    // Each "stdout" row is one JSON line emitted by the agent.
    const line = msg.data.trim();
    if (!line.includes("permission_denials")) continue;
    let evt: { type?: string; permission_denials?: { tool_name?: string; tool_use_id?: string; tool_input?: { questions?: AgentQuestion[] } }[] };
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt.type !== "result" || !Array.isArray(evt.permission_denials)) continue;
    for (const denial of evt.permission_denials) {
      if (denial.tool_name !== "AskUserQuestion") continue;
      const qs = denial.tool_input?.questions;
      const toolUseId = denial.tool_use_id;
      if (!toolUseId || !Array.isArray(qs) || qs.length === 0) continue;
      out.push({ toolUseId, questions: qs });
    }
  }
  return out;
}

/**
 * List pending (unanswered) AskUserQuestion sets across all workspaces of a project.
 * Compute-on-read: scans the most recent completed session per workspace.
 */
export async function listPendingQuestionsForProject(
  projectId: string,
  db: Database,
): Promise<PendingQuestionSet[]> {
  // Pull all workspaces+issues for this project (one query).
  const wsRows = await db
    .select({
      workspaceId: workspaces.id,
      issueId: issues.id,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(eq(issues.projectId, projectId));

  const results: PendingQuestionSet[] = [];

  for (const ws of wsRows) {
    // Most-recent session (any status) for this workspace.
    const sessRows = await db
      .select({ id: sessions.id, endedAt: sessions.endedAt, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.workspaceId, ws.workspaceId))
      .orderBy(desc(sessions.startedAt))
      .limit(1);
    const sess = sessRows[0];
    if (!sess) continue;
    // Only look at completed (or stopped) sessions — a running session may not have the result yet.
    if (sess.status === "running") continue;

    const msgs = await db
      .select({ type: sessionMessages.type, data: sessionMessages.data })
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sess.id));

    const extracted = extractQuestionsFromSession(msgs);
    for (const { toolUseId, questions } of extracted) {
      if (await isAnswered(toolUseId, db)) continue;
      results.push({
        toolUseId,
        workspaceId: ws.workspaceId,
        sessionId: sess.id,
        issueId: ws.issueId,
        issueNumber: ws.issueNumber,
        issueTitle: ws.issueTitle,
        questions,
        askedAt: sess.endedAt,
      });
    }
  }

  return results;
}

/**
 * Format the user's answers as a plain-text follow-up message for the agent.
 * Mirrors the structure the agent originally asked, so it can reconcile easily.
 */
export function formatAnswerMessage(
  questions: AgentQuestion[],
  answers: { selectedLabels: string[]; freeText?: string }[],
): string {
  const lines: string[] = ["Here are my answers to your questions:", ""];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const a = answers[i] ?? { selectedLabels: [] };
    const header = q.header ? `${q.header}: ` : "";
    lines.push(`${i + 1}. ${header}${q.question}`);
    if (a.selectedLabels.length > 0) {
      for (const label of a.selectedLabels) {
        lines.push(`   - ${label}`);
      }
    }
    if (a.freeText && a.freeText.trim()) {
      lines.push(`   Note: ${a.freeText.trim()}`);
    }
    lines.push("");
  }
  lines.push("Please proceed with these answers.");
  return lines.join("\n");
}
