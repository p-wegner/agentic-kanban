import { issues, workspaces, sessions, sessionMessages } from "@agentic-kanban/shared/schema";
import { eq, inArray, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { parseSessionSummary, formatDurationStr } from "../services/session-summary.js";

type Issue = typeof issues.$inferSelect;
type Workspace = typeof workspaces.$inferSelect;
type Session = typeof sessions.$inferSelect;

export interface IssueSummaryResult {
  issueId: string;
  issueNumber: number | null;
  title: string;
  workspace: { id: string; branch: string | null; status: string } | null;
  session: { id: string; status: string; startedAt: string | null; endedAt: string | null; duration: string | null } | null;
  stats: {
    durationMs: number;
    totalCostUsd: number;
    inputTokens: number;
    outputTokens: number;
    numTurns: number;
    model: string | null;
    success: boolean;
  } | null;
  agentSummary: string | null;
  filesEdited: string[];
  filesRead: string[];
  commandsRun: string[];
  errors: string[];
  model: string | null;
  status?: string;
  summary?: null;
}

export async function getIssueSummary(
  idParam: string,
  database: Database = db,
): Promise<IssueSummaryResult | null> {
  const isNumeric = /^\d+$/.test(idParam);
  const issueRows = isNumeric
    ? await database.select().from(issues).where(eq(issues.issueNumber, Number(idParam))).limit(1)
    : await database.select().from(issues).where(eq(issues.id, idParam)).limit(1);

  if (issueRows.length === 0) return null;

  const issue = issueRows[0];

  const wsRows = await database.select().from(workspaces).where(eq(workspaces.issueId, issue.id));

  if (wsRows.length === 0) {
    return { issueId: issue.id, issueNumber: issue.issueNumber, title: issue.title, status: "no workspace", summary: null, workspace: null, session: null, stats: null, agentSummary: null, filesEdited: [], filesRead: [], commandsRun: [], errors: [], model: null };
  }

  const wsIds = wsRows.map(w => w.id);
  const sessionRows = await database
    .select()
    .from(sessions)
    .where(inArray(sessions.workspaceId, wsIds))
    .orderBy(desc(sessions.startedAt));

  const completedSession = sessionRows.find(s => s.status === "completed" || s.status === "stopped")
    ?? sessionRows[0]
    ?? null;

  if (!completedSession) {
    return { issueId: issue.id, issueNumber: issue.issueNumber, title: issue.title, status: "no session", summary: null, workspace: null, session: null, stats: null, agentSummary: null, filesEdited: [], filesRead: [], commandsRun: [], errors: [], model: null };
  }

  const msgRows = await database
    .select()
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, completedSession.id))
    .orderBy(sessionMessages.id);

  let parsedStats: Record<string, unknown> | null = null;
  if (completedSession.stats) {
    try { parsedStats = JSON.parse(completedSession.stats); } catch { /* ignore */ }
  }

  let duration: string | null = null;
  if (completedSession.endedAt && completedSession.startedAt) {
    const diffMs = new Date(completedSession.endedAt).getTime() - new Date(completedSession.startedAt).getTime();
    duration = formatDurationStr(diffMs);
  }

  const summary = parseSessionSummary(msgRows);
  if (!summary.agentSummary && parsedStats && typeof parsedStats.agentSummary === "string") {
    summary.agentSummary = parsedStats.agentSummary;
  }

  const matchingWorkspace = wsRows.find(w => w.id === completedSession.workspaceId);

  return {
    issueId: issue.id,
    issueNumber: issue.issueNumber,
    title: issue.title,
    workspace: matchingWorkspace ? { id: matchingWorkspace.id, branch: matchingWorkspace.branch, status: matchingWorkspace.status } : null,
    session: { id: completedSession.id, status: completedSession.status, startedAt: completedSession.startedAt, endedAt: completedSession.endedAt, duration },
    stats: parsedStats ? {
      durationMs: (parsedStats as any).durationMs ?? 0,
      totalCostUsd: (parsedStats as any).totalCostUsd ?? 0,
      inputTokens: (parsedStats as any).inputTokens ?? 0,
      outputTokens: (parsedStats as any).outputTokens ?? 0,
      numTurns: (parsedStats as any).numTurns ?? 1,
      model: (parsedStats as any).model ?? summary.model,
      success: (parsedStats as any).success ?? false,
    } : null,
    ...summary,
  };
}
