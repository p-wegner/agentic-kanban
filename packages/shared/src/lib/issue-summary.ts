/**
 * issue → workspaces → representative session → parsed summary, once (#506).
 *
 * The same six-step chain was implemented three times — the REST repository
 * (`getIssueSummary`), the CLI `issue summary` command, and the MCP `get_issue_summary`
 * tool — and the three had drifted on the two decisions that matter:
 *
 * - **Which session.** The CLI skipped analytics noise via `selectSummarySession`; REST
 *   and MCP took `find(completed|stopped) ?? rows[0]` and would summarize a board-monitor
 *   session as the agent's work on the ticket.
 * - **Which project.** REST and MCP resolved a bare issue NUMBER with no project filter.
 *   Numbers are per-project, so that matched a row in every project that had reached N.
 *   (Fixed at each call site first; the scoping now lives here so it cannot un-fix.)
 *
 * Parameterised over a Drizzle handle (`WorkflowDb`) like `issue-status-orchestration.ts`,
 * so the server `Database` and the MCP `ToolDb` both pass it unchanged. Nothing here
 * imports server code.
 */
import { and, eq, inArray, desc } from "drizzle-orm";
import * as schema from "../schema/index.js";
import type { WorkflowDb } from "./workflow-engine/types.js";
import { parseSessionSummary, formatDurationStr } from "./session-summary.js";
import { parseSessionStatsBlob } from "./session-stats-blob.js";
import { readSessionStdoutFile } from "./session-files.js";
import { isAnalyticsNoise, selectSummarySession } from "./session-selection.js";

export interface IssueSummaryStats {
  durationMs: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  model: string | null;
  success: boolean;
}

/**
 * The wire shape. Deliberately a PARTIAL description of what is returned: the successful
 * path spreads the whole `SessionSummary` (overview, actions, keyExcerpts, tasks, …), and
 * this interface names only the fields the three surfaces contract on — which is exactly
 * how the server declared it before the move.
 */
export interface IssueSummaryResult {
  issueId: string;
  issueNumber: number | null;
  title: string;
  workspace: { id: string; branch: string | null; status: string } | null;
  session: {
    id: string;
    status: string;
    startedAt: string | null;
    endedAt: string | null;
    duration: string | null;
  } | null;
  stats: IssueSummaryStats | null;
  agentSummary: string | null;
  filesEdited: string[];
  filesRead: string[];
  commandsRun: string[];
  errors: string[];
  model: string | null;
  /** Present only on the degenerate results: "no workspace" / "no session". */
  status?: string;
  summary?: null;
}

/**
 * How to find the issue. `issueId` (a UUID) is unambiguous on its own; `issueNumber` is
 * per-project and so is scoped by `projectId` when one is given. Callers resolve the
 * project themselves (explicit argument > active-project preference), and pass nothing
 * when a board has no active project — the lookup then stays unscoped, which is the
 * pre-#506 behaviour and keeps a single-project board working.
 */
export interface IssueSummaryRef {
  issueId?: string;
  issueNumber?: number;
  projectId?: string;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" ? v : fallback;
}

/**
 * Project the parsed stats blob into the summary's `stats` shape, applying the
 * historical defaults (numTurns defaults to 1; model falls back to the parsed
 * session-summary model). Returns null when there is no stats blob.
 */
export function projectSessionStats(
  parsedStats: Record<string, unknown> | null,
  fallbackModel: string | null,
): IssueSummaryStats | null {
  if (!parsedStats) return null;
  const model = parsedStats.model;
  return {
    durationMs: num(parsedStats.durationMs, 0),
    totalCostUsd: num(parsedStats.totalCostUsd, 0),
    inputTokens: num(parsedStats.inputTokens, 0),
    outputTokens: num(parsedStats.outputTokens, 0),
    numTurns: num(parsedStats.numTurns, 1),
    model: typeof model === "string" ? model : fallbackModel,
    success: parsedStats.success === true,
  };
}

/** Format the elapsed time between two ISO timestamps, or null if either is missing. */
export function computeSessionDuration(startedAt: string | null, endedAt: string | null): string | null {
  if (!startedAt || !endedAt) return null;
  return formatDurationStr(new Date(endedAt).getTime() - new Date(startedAt).getTime());
}

const EMPTY_SUMMARY = {
  summary: null,
  agentSummary: null,
  filesEdited: [] as string[],
  filesRead: [] as string[],
  commandsRun: [] as string[],
  errors: [] as string[],
  model: null,
};

function degenerate(
  issue: { id: string; issueNumber: number | null; title: string },
  status: string,
): IssueSummaryResult {
  return {
    issueId: issue.id,
    issueNumber: issue.issueNumber,
    title: issue.title,
    status,
    workspace: null,
    session: null,
    stats: null,
    ...EMPTY_SUMMARY,
  };
}

/**
 * Load a session's output rows, preferring the on-disk .out file (where detached agents
 * stream stdout) and falling back to persisted `session_messages` for historical
 * sessions. Mirrors the server repository's `getSessionMessageRows`; kept local so this
 * module stays free of server imports.
 */
async function loadSessionMessageRows(
  db: WorkflowDb,
  sessionId: string,
): Promise<Array<{ type: string; data: string | null }>> {
  const dbRows = await db
    .select({ type: schema.sessionMessages.type, data: schema.sessionMessages.data })
    .from(schema.sessionMessages)
    .where(eq(schema.sessionMessages.sessionId, sessionId))
    .orderBy(schema.sessionMessages.id);

  const fileContent = readSessionStdoutFile(sessionId);
  if (fileContent === null) return dbRows;
  // File present: stdout from the file, everything else from the DB.
  return [{ type: "stdout", data: fileContent }, ...dbRows.filter((r) => r.type !== "stdout")];
}

/**
 * Resolve an issue to its representative agent session and parse that session's summary.
 * Returns null only when the issue itself does not exist; an issue with no workspace or
 * no session comes back as a result carrying `status: "no workspace" | "no session"`.
 */
export async function loadIssueSummary(
  db: WorkflowDb,
  ref: IssueSummaryRef,
): Promise<IssueSummaryResult | null> {
  const where = ref.issueId !== undefined
    ? eq(schema.issues.id, ref.issueId)
    : ref.projectId !== undefined
      ? and(eq(schema.issues.issueNumber, ref.issueNumber as number), eq(schema.issues.projectId, ref.projectId))
      : eq(schema.issues.issueNumber, ref.issueNumber as number);

  const issueRows = await db.select().from(schema.issues).where(where).limit(1);
  if (issueRows.length === 0) return null;
  const issue = issueRows[0];

  const wsRows = await db.select().from(schema.workspaces).where(eq(schema.workspaces.issueId, issue.id));
  if (wsRows.length === 0) return degenerate(issue, "no workspace");

  const sessionRows = await db
    .select()
    .from(schema.sessions)
    .where(inArray(schema.sessions.workspaceId, wsRows.map((w) => w.id)))
    .orderBy(desc(schema.sessions.startedAt));

  const session = selectSummarySession(sessionRows, isAnalyticsNoise);
  if (!session) return degenerate(issue, "no session");

  const msgRows = await loadSessionMessageRows(db, session.id);
  const parsedStats = parseSessionStatsBlob(session.stats);
  const summary = parseSessionSummary(msgRows);
  if (!summary.agentSummary && parsedStats && typeof parsedStats.agentSummary === "string") {
    summary.agentSummary = parsedStats.agentSummary;
  }

  const workspace = wsRows.find((w) => w.id === session.workspaceId);

  return {
    issueId: issue.id,
    issueNumber: issue.issueNumber,
    title: issue.title,
    workspace: workspace ? { id: workspace.id, branch: workspace.branch, status: workspace.status } : null,
    session: {
      id: session.id,
      status: session.status,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      duration: computeSessionDuration(session.startedAt, session.endedAt),
    },
    stats: projectSessionStats(parsedStats, summary.model),
    ...summary,
  };
}
