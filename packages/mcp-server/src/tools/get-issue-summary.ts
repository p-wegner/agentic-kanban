import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, inArray, desc } from "drizzle-orm";
import { parseSessionSummary, formatDurationStr } from "@agentic-kanban/shared";
import { requireEntity, readSessionStdoutFile, resolveActiveProjectId } from "../db-utils.js";
import { prodDeps, type ToolDeps } from "./deps.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * Shape of the dynamic `sessions.stats` JSON blob, as read by this tool. All
 * fields are optional because the blob is parsed from untyped JSON and older
 * sessions may omit any of them (the `??` defaults below cover absent fields).
 */
interface SessionStatsBlob {
  durationMs?: number;
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
  model?: string;
  success?: boolean;
  agentSummary?: string;
}

/**
 * #506: takes injected `ToolDeps` like its sibling tools instead of importing the
 * module-level `db`/`schema` singletons. It was the only reason this tool had no tests —
 * the harness could not give it a seeded database, so the cross-project resolution bug it
 * carried had no way to be caught.
 */
export function registerGetIssueSummary(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "get_issue_summary",
    "Get a summary of the latest completed agent session for an issue. Resolves issue number → workspace → latest session → parsed summary in one call. Shows agent summary text, files touched, commands run, duration, cost, and key excerpts. Complements get_board_status (live state) with completed-work history.",
    {
      issueNumber: z.number().describe("The issue number (e.g. 1, 2, 3)"),
      projectId: z.string().optional().describe("Project ID — defaults to the active project. Issue numbers are per-project, so an unscoped number is ambiguous."),
    },
    async ({ issueNumber, projectId }) => {
      try {
        // 1. Resolve issue by number, SCOPED to a project (#506).
        //
        // This used to be a bare `where(issueNumber = N).limit(1)`. Issue numbers are
        // per-project (`MAX(issue_number) + 1`), so that matched a row in every project
        // that had reached N and returned an arbitrary one — verified live on a 25-project
        // board, where issue #5 resolved to a fixture project rather than the active one.
        // Same fallback as get_issue: explicit projectId > active project > unscoped. The
        // unscoped tail keeps a no-active-project board working exactly as before.
        const projectResolution = await resolveActiveProjectId(db, schema, projectId);
        const scopeProjectId = projectResolution.ok ? projectResolution.projectId : null;
        const issueRows = await db
          .select()
          .from(schema.issues)
          .where(scopeProjectId
            ? and(eq(schema.issues.issueNumber, issueNumber), eq(schema.issues.projectId, scopeProjectId))
            : eq(schema.issues.issueNumber, issueNumber))
          .limit(1);

        const r = requireEntity(issueRows, String(issueNumber), "Issue #");
        if (!r.ok) return r.error;

        const issue = r.value;

        // 2. Find workspaces for this issue
        const wsRows = await db
          .select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.issueId, issue.id));

        if (wsRows.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                issueId: issue.id,
                issueNumber: issue.issueNumber,
                title: issue.title,
                status: "no workspace",
                summary: null,
              }, null, 2),
            }],
          };
        }

        // 3. Find latest completed session across all workspaces
        const wsIds = wsRows.map(w => w.id);
        const sessionRows = await db
          .select()
          .from(schema.sessions)
          .where(inArray(schema.sessions.workspaceId, wsIds))
          .orderBy(desc(schema.sessions.startedAt));

        const completedSession = sessionRows.find(s => s.status === "completed" || s.status === "stopped")
          ?? sessionRows[0]
          ?? null;

        if (!completedSession) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                issueId: issue.id,
                issueNumber: issue.issueNumber,
                title: issue.title,
                status: "no session",
                summary: null,
              }, null, 2),
            }],
          };
        }

        // 4. Fetch session messages — prefer .out file for stdout, fall back to DB
        let msgRows: Array<{ type: string; data: string | null }>;
        const fileContent = readSessionStdoutFile(completedSession.id);
        if (fileContent !== null) {
          const nonStdout = await db
            .select({ type: schema.sessionMessages.type, data: schema.sessionMessages.data })
            .from(schema.sessionMessages)
            .where(eq(schema.sessionMessages.sessionId, completedSession.id))
            .orderBy(schema.sessionMessages.id);
          msgRows = [{ type: "stdout", data: fileContent }, ...nonStdout.filter(r => r.type !== "stdout")];
        } else {
          msgRows = await db
            .select()
            .from(schema.sessionMessages)
            .where(eq(schema.sessionMessages.sessionId, completedSession.id))
            .orderBy(schema.sessionMessages.id);
        }

        // 5. Parse stats
        let stats: SessionStatsBlob | null = null;
        if (completedSession.stats) {
          try { stats = JSON.parse(completedSession.stats) as SessionStatsBlob; } catch { /* ignore */ }
        }

        // 6. Compute duration
        let duration: string | null = null;
        if (completedSession.endedAt && completedSession.startedAt) {
          const diffMs = new Date(completedSession.endedAt).getTime() - new Date(completedSession.startedAt).getTime();
          duration = formatDurationStr(diffMs);
        }

        // 7. Parse summary
        const summary = parseSessionSummary(msgRows);

        if (!summary.agentSummary && stats && typeof stats.agentSummary === "string") {
          summary.agentSummary = stats.agentSummary;
        }

        const matchingWorkspace = wsRows.find(w => w.id === completedSession.workspaceId);

        const result = {
          issueId: issue.id,
          issueNumber: issue.issueNumber,
          title: issue.title,
          workspace: matchingWorkspace ? {
            id: matchingWorkspace.id,
            branch: matchingWorkspace.branch,
            status: matchingWorkspace.status,
          } : null,
          session: {
            id: completedSession.id,
            status: completedSession.status,
            startedAt: completedSession.startedAt,
            endedAt: completedSession.endedAt,
            duration,
          },
          stats: stats ? {
            durationMs: stats.durationMs ?? 0,
            totalCostUsd: stats.totalCostUsd ?? 0,
            inputTokens: stats.inputTokens ?? 0,
            outputTokens: stats.outputTokens ?? 0,
            numTurns: stats.numTurns ?? 1,
            model: stats.model ?? summary.model,
            success: stats.success ?? false,
          } : null,
          ...summary,
        };

        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${errorMessage(err)}` }] };
      }
    },
  );
}
