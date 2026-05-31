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
import { isTerminalStatusView } from "@agentic-kanban/shared";
import { sessions, sessionMessages, workspaces, issues, projects, projectStatuses, issueComments, workflowNodes } from "@agentic-kanban/shared/schema";
import { eq, desc } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
import { ensureButlerSession, sendButlerTurn, subscribeButler, getButlerSession } from "./butler-sdk.service.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";

/** Function signature for sending a follow-up turn to a workspace — injected so this
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

function parseSyntheticQuestionPayload(
  payload: string | null,
): { toolUseId: string; questions: AgentQuestion[] } | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { toolUseId?: unknown; questions?: unknown; source?: unknown };
    if (parsed.source !== "mcp_clarify_or_propose") return null;
    if (typeof parsed.toolUseId !== "string" || !Array.isArray(parsed.questions)) return null;
    const questions = parsed.questions
      .map((q): AgentQuestion | null => {
        if (!q || typeof q !== "object") return null;
        const raw = q as {
          question?: unknown;
          header?: unknown;
          multiSelect?: unknown;
          options?: unknown;
        };
        if (typeof raw.question !== "string" || !raw.question.trim()) return null;
        const rawOptions = Array.isArray(raw.options) ? raw.options : [];
        const options = rawOptions
          .map((opt): AgentQuestionOption | null => {
            if (!opt || typeof opt !== "object") return null;
            const rawOpt = opt as { label?: unknown; description?: unknown };
            if (typeof rawOpt.label !== "string" || !rawOpt.label.trim()) return null;
            return {
              label: rawOpt.label,
              ...(typeof rawOpt.description === "string" ? { description: rawOpt.description } : {}),
            };
          })
          .filter((opt): opt is AgentQuestionOption => opt !== null);
        return {
          question: raw.question,
          ...(typeof raw.header === "string" ? { header: raw.header } : {}),
          ...(typeof raw.multiSelect === "boolean" ? { multiSelect: raw.multiSelect } : {}),
          options: options.length > 0 ? options : [{ label: "Answer in free text" }],
        };
      })
      .filter((q): q is AgentQuestion => q !== null);
    return questions.length > 0 ? { toolUseId: parsed.toolUseId, questions } : null;
  } catch {
    return null;
  }
}

function answeredPrefKey(toolUseId: string): string {
  return `agent_question_answered_${toolUseId}`;
}

function recommendationPrefKey(toolUseId: string): string {
  return `agent_question_recommendation_${toolUseId}`;
}

/** Returns true if this AskUserQuestion ask has been resolved — either answered (and
 *  re-sent) or dismissed. Both write the same `agent_question_answered_<id>` pref, so a
 *  resolved question stops appearing in the pending list. The legacy value is the literal
 *  string "1"; dismissals store a JSON object `{ dismissed: true, dismissedAt }`. */
export async function isAnswered(toolUseId: string, db: Database): Promise<boolean> {
  return (await getPreference(answeredPrefKey(toolUseId), db)) !== null;
}

export async function markAnswered(toolUseId: string, db: Database): Promise<void> {
  await setPreference(answeredPrefKey(toolUseId), "1", db);
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
    const wsRows = await db
      .select({ issueId: workspaces.issueId })
      .from(workspaces)
      .where(eq(workspaces.id, params.workspaceId))
      .limit(1);
    const issueId = wsRows[0]?.issueId;
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
    console.error(`[agent-questions] failed to write agent-question comment: toolUseId=${params.toolUseId} ${err instanceof Error ? err.message : err}`);
  }
}

/** Mark a pending question dismissed by the user. The corresponding workspace is NOT
 *  relaunched or notified — the row is kept (not deleted) for audit. Stores
 *  `{ dismissed: true, dismissedAt }` under the same answered pref key so the question
 *  disappears from the pending list. `dismissedAt` is passed in (callers stamp the time)
 *  so the service stays free of `Date.now()`/`new Date()`. */
export async function markDismissed(toolUseId: string, dismissedAt: string, db: Database): Promise<void> {
  await setPreference(answeredPrefKey(toolUseId), JSON.stringify({ dismissed: true, dismissedAt }), db);
}

/** Cached recommendation array, one entry per sub-question. A null entry = couldn't recommend
 *  (e.g. butler returned malformed JSON); the *outer* return is null = not yet computed. */
export async function getCachedRecommendations(
  toolUseId: string,
  db: Database,
): Promise<Array<AgentQuestionRecommendation | null> | null> {
  const raw = await getPreference(recommendationPrefKey(toolUseId), db);
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
  await setPreference(recommendationPrefKey(toolUseId), JSON.stringify({ recommendations }), db);
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

const STALENESS_LABELS: Record<StalenessReason, string> = {
  "workspace-merged": "stale — workspace merged",
  "issue-done": "stale — issue done",
  "superseded": "stale — superseded",
  "older-than-24h": "stale — older than 24h",
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

/**
 * Decide whether a pending question is stale, and why. Priority order matches the
 * ticket: workspace merged → issue done → superseded → older than 24h. Returns null
 * when the question is still fresh. Pure (time passed in) so it is unit-testable.
 */
export function computeStaleness(input: StalenessInput): Staleness | null {
  // 1. Workspace merged / closed.
  if (input.workspaceStatus === "closed" || (input.readyForMerge && input.workspaceClosedAt)) {
    return { reason: "workspace-merged", label: STALENESS_LABELS["workspace-merged"], at: input.workspaceClosedAt };
  }
  // 2. Issue moved to a terminal workflow node or legacy terminal status.
  if (isTerminalStatusView({
    currentNodeId: input.issueCurrentNodeId,
    currentNodeType: input.issueCurrentNodeType,
    statusName: input.issueStatusName,
  })) {
    return { reason: "issue-done", label: STALENESS_LABELS["issue-done"], at: null };
  }
  // 3. A newer session exists than the one that produced the question.
  if (
    input.questionSessionStartedAt &&
    input.latestSessionStartedAt &&
    input.latestSessionStartedAt > input.questionSessionStartedAt
  ) {
    return { reason: "superseded", label: STALENESS_LABELS["superseded"], at: input.latestSessionStartedAt };
  }
  // 4. Fallback: older than 24h.
  if (input.askedAt) {
    const ageMs = new Date(input.now).getTime() - new Date(input.askedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs > 24 * 60 * 60 * 1000) {
      return { reason: "older-than-24h", label: STALENESS_LABELS["older-than-24h"], at: input.askedAt };
    }
  }
  return null;
}

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
  // Pull all workspaces+issues for this project (one query). Includes the workspace
  // status/closedAt/readyForMerge and the issue's status-column name so staleness can
  // be computed per card without extra round-trips.
  const wsRows = await db
    .select({
      workspaceId: workspaces.id,
      workspaceStatus: workspaces.status,
      workspaceClosedAt: workspaces.closedAt,
      readyForMerge: workspaces.readyForMerge,
      issueId: issues.id,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
      issueDescription: issues.description,
      issueStatusName: projectStatuses.name,
      issueCurrentNodeId: issues.currentNodeId,
      issueCurrentNodeType: workflowNodes.nodeType,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(eq(issues.projectId, projectId));

  const results: PendingQuestionSet[] = [];
  const now = nowOverride ?? new Date().toISOString();

  for (const ws of wsRows) {
    // Recent sessions (any status), newest first. We scan a few because a question
    // asked in an older session is "superseded" once a newer session has run.
    const sessRows = await db
      .select({ id: sessions.id, startedAt: sessions.startedAt, endedAt: sessions.endedAt, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.workspaceId, ws.workspaceId))
      .orderBy(desc(sessions.startedAt))
      .limit(10);
    if (sessRows.length === 0) continue;
    const latestSession = sessRows[0];

    // Find the newest non-running session that actually carries pending questions.
    for (const sess of sessRows) {
      // A running session may not have the result yet.
      if (sess.status === "running") continue;

      const msgs = await db
        .select({ type: sessionMessages.type, data: sessionMessages.data })
        .from(sessionMessages)
        .where(eq(sessionMessages.sessionId, sess.id));

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

  const syntheticRows = await db
    .select({
      id: issueComments.id,
      issueId: issueComments.issueId,
      workspaceId: issueComments.workspaceId,
      body: issueComments.body,
      payload: issueComments.payload,
      createdAt: issueComments.createdAt,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
    })
    .from(issueComments)
    .innerJoin(issues, eq(issueComments.issueId, issues.id))
    .where(eq(issues.projectId, projectId))
    .orderBy(desc(issueComments.createdAt));

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

  return results;
}

/** In-flight recommendation calls, keyed by toolUseId — prevents duplicate butler turns
 *  when multiple list pollers race. */
const inFlightRecommendations = new Set<string>();

interface RecommendInput {
  toolUseId: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  issueDescription: string | null;
  questions: AgentQuestion[];
}

interface AutoAnswerDeps {
  workspaceId: string;
  sendTurn: AutoAnswerSendTurn;
}

function scheduleBackgroundRecommendation(projectId: string, input: RecommendInput, db: Database, autoAnswerDeps?: AutoAnswerDeps): void {
  if (inFlightRecommendations.has(input.toolUseId)) return;
  inFlightRecommendations.add(input.toolUseId);
  void (async () => {
    try {
      const recs = await recommendQuestionsForSet(projectId, input, db);
      await setCachedRecommendations(input.toolUseId, recs, db);
      if (autoAnswerDeps) {
        await tryAutoAnswer(input.toolUseId, autoAnswerDeps.workspaceId, input.questions, recs, autoAnswerDeps.sendTurn, db);
      }
    } catch (err) {
      console.error(`[agent-questions] background recommend failed: toolUseId=${input.toolUseId} ${err instanceof Error ? err.message : err}`);
      // Cache nulls so we don't re-poll on every list call.
      await setCachedRecommendations(input.toolUseId, input.questions.map(() => null), db);
    } finally {
      inFlightRecommendations.delete(input.toolUseId);
    }
  })();
}

/**
 * Attempt to auto-answer a question set using butler recommendations if the
 * `butler_auto_answer` preference is enabled.
 *
 * Requirements for auto-answering:
 * - `butler_auto_answer` preference is "true"
 * - All recommendations are non-null (butler must be confident on every sub-question)
 * - For single-select questions: recommendation has ≥1 selected option or freeText
 * - Butler session must not have been interrupted (recs already non-null means it ran)
 */
export async function tryAutoAnswer(
  toolUseId: string,
  workspaceId: string,
  questions: AgentQuestion[],
  recs: Array<AgentQuestionRecommendation | null>,
  sendTurn: AutoAnswerSendTurn,
  db: Database,
): Promise<void> {
  const autoAnswerEnabled = await getPreference("butler_auto_answer", db);
  if (autoAnswerEnabled !== "true") return;

  // All sub-questions must have a non-null recommendation.
  if (recs.some((r) => r === null)) {
    console.info(`[agent-questions] auto-answer skipped: incomplete recommendations toolUseId=${toolUseId}`);
    return;
  }

  // For single-select questions, require at least one selected option or freeText.
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const rec = recs[i]!;
    if (!q.multiSelect && rec.recommendedOptionIndexes.length === 0 && !rec.freeText) {
      console.info(`[agent-questions] auto-answer skipped: no clear winner for question ${i} toolUseId=${toolUseId}`);
      return;
    }
  }

  // Build answers from recommendations.
  const answers = buildAnswersFromRecommendations(questions, recs as AgentQuestionRecommendation[]);
  const content = formatAnswerMessage(questions, answers);

  const chosenLabels = questions.map((q, i) => {
    const rec = recs[i]!;
    const labels = rec.recommendedOptionIndexes.map((idx) => q.options[idx]?.label).filter(Boolean);
    return labels.length > 0 ? labels.join(", ") : rec.freeText ?? "(none)";
  });
  const rationales = (recs as AgentQuestionRecommendation[]).map((r) => r.rationale).join("; ");

  try {
    await sendTurn(workspaceId, content);
    await markAnswered(toolUseId, db);
    await writeAgentQuestionComment(
      { toolUseId, workspaceId, questions, answers, body: content, author: "butler" },
      db,
    );
    const firstQ = questions[0]?.question ?? "(unknown)";
    console.info(
      `[agent-questions] auto-answered toolUseId=${toolUseId} workspaceId=${workspaceId} ` +
      `question="${firstQ.slice(0, 80)}" chosen="${chosenLabels.join(" | ")}" rationale="${rationales.slice(0, 160)}"`,
    );
  } catch (err) {
    console.error(`[agent-questions] auto-answer send failed: toolUseId=${toolUseId} ${err instanceof Error ? err.message : err}`);
  }
}

/** Build answer structs from butler recommendations — the server-side equivalent of the
 *  client's emptyAnswers() initializer. */
function buildAnswersFromRecommendations(
  questions: AgentQuestion[],
  recs: AgentQuestionRecommendation[],
): { selectedLabels: string[]; freeText?: string }[] {
  return questions.map((q, i) => {
    const rec = recs[i];
    if (!rec) return { selectedLabels: [] };
    const selectedLabels: string[] = [];
    for (const idx of rec.recommendedOptionIndexes) {
      const opt = q.options[idx];
      if (opt) selectedLabels.push(opt.label);
    }
    const freeText = selectedLabels.length === 0 && rec.freeText ? rec.freeText : undefined;
    return { selectedLabels, ...(freeText ? { freeText } : {}) };
  });
}

function buildRecommendationPrompt(input: RecommendInput): string {
  const issueRef = input.issueNumber !== null ? `#${input.issueNumber}: ${input.issueTitle}` : input.issueTitle;
  const desc = (input.issueDescription ?? "").slice(0, 500).trim();
  const lines: string[] = [
    `You are helping the user answer a question that an agent paused on.`,
    ``,
    `Issue ${issueRef}`,
  ];
  if (desc) lines.push(``, desc);
  lines.push(``, `The agent asked:`);
  input.questions.forEach((q, i) => {
    const header = q.header ? `${q.header}: ` : "";
    lines.push(`Question ${i + 1}: ${header}${q.question}`);
    lines.push(`  multiSelect: ${q.multiSelect ? "yes" : "no"}`);
    lines.push(`  Options:`);
    q.options.forEach((opt, j) => {
      const dsc = opt.description ? ` — ${opt.description}` : "";
      lines.push(`    [${j}] ${opt.label}${dsc}`);
    });
  });
  lines.push(
    ``,
    `Recommend an answer for each question. Reply with ONLY a JSON array (no prose, no code fences), one entry per question, in order:`,
    `[{"recommendedOptionIndexes":[0],"rationale":"short reason under 120 chars"}, ...]`,
    ``,
    `Rules:`,
    `- Use option indexes (0-based) from the Options list above.`,
    `- For single-select questions: exactly one index in recommendedOptionIndexes (or [] if none fit).`,
    `- For multi-select: zero or more indexes.`,
    `- If none of the options fit, set "freeText" to a short suggested reply and leave recommendedOptionIndexes as [].`,
    `- Keep each rationale under 120 characters and grounded in the ticket if relevant.`,
  );
  return lines.join("\n");
}

/** Strip code fences / leading prose and extract the first JSON array in the text. */
export function extractJsonArray(text: string): unknown {
  if (!text) throw new Error("empty butler response");
  let s = text.trim();
  // Strip ```json ... ``` or ``` ... ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // Find first '[' and last ']' to tolerate leading/trailing prose.
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) throw new Error("no JSON array found in butler response");
  return JSON.parse(s.slice(start, end + 1));
}

export function coerceRecommendation(raw: unknown, optionCount: number, multi: boolean): AgentQuestionRecommendation | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { recommendedOptionIndexes?: unknown; freeText?: unknown; rationale?: unknown };
  const rationale = typeof r.rationale === "string" ? r.rationale.trim().slice(0, 240) : "";
  const idxArr = Array.isArray(r.recommendedOptionIndexes) ? r.recommendedOptionIndexes : [];
  const indexes: number[] = [];
  for (const v of idxArr) {
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < optionCount) {
      indexes.push(v);
    }
  }
  // Enforce single-select cardinality.
  const finalIndexes = multi ? indexes : indexes.slice(0, 1);
  const freeText = typeof r.freeText === "string" && r.freeText.trim() ? r.freeText.trim() : undefined;
  if (finalIndexes.length === 0 && !freeText && !rationale) return null;
  return { recommendedOptionIndexes: finalIndexes, rationale: rationale || (freeText ? "Butler suggests a free-text reply." : "Butler's pick."), ...(freeText ? { freeText } : {}) };
}

/** Run one short butler turn for this question set and return per-question recommendations.
 *  Uses the warm SDK session if present, starting it on demand. The call is a one-shot
 *  prompt — listeners are attached, the turn pushed, and we resolve on the next `result`. */
export async function recommendQuestionsForSet(
  projectId: string,
  input: RecommendInput,
  db: Database,
): Promise<Array<AgentQuestionRecommendation | null>> {
  // Ensure a butler session exists; if not, start one from the project record so the
  // recommender works even before the user opens the Butler view.
  if (!getButlerSession(projectId).active) {
    const projRows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    const project = projRows[0];
    if (!project) throw new Error(`project not found: ${projectId}`);
    const claudeProfile = (await getPreference(`butler_profile_${projectId}`, db))
      || (await getPreference("claude_profile", db))
      || undefined;
    const model = (await getPreference(`butler_model_${projectId}`, db)) || undefined;
    const resumeSessionId = (await getPreference(`butler_session_${projectId}`, db)) || undefined;
    ensureButlerSession({
      projectId,
      repoPath: project.repoPath,
      projectName: project.name,
      claudeProfile,
      model,
      resumeSessionId,
    });
  }

  const prompt = buildRecommendationPrompt(input);
  const timeoutMs = 45_000;
  const answer = await new Promise<{ text: string; isError: boolean }>((resolve) => {
    let buf = "";
    let settled = false;
    const finish = (text: string, isError: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve({ text, isError });
    };
    const unsubscribe = subscribeButler(projectId, (e) => {
      if (e.type === "text") buf += e.text;
      else if (e.type === "result") finish(e.text ?? buf, e.isError ?? false);
      else if (e.type === "error") finish(e.message, true);
    });
    const timer = setTimeout(() => finish(buf || "(timed out)", true), timeoutMs);
    sendButlerTurn(projectId, prompt);
  });

  if (answer.isError) {
    throw new Error(`butler returned error: ${answer.text.slice(0, 200)}`);
  }

  const parsed = extractJsonArray(answer.text);
  if (!Array.isArray(parsed)) throw new Error("butler response was not a JSON array");
  return input.questions.map((q, i) => coerceRecommendation(parsed[i], q.options.length, !!q.multiSelect));
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
