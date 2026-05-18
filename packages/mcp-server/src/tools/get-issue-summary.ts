import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq, inArray, desc } from "drizzle-orm";
import { parseSessionSummary, formatDurationStr } from "@agentic-kanban/shared";

export function registerGetIssueSummary(server: McpServer) {
  server.tool(
    "get_issue_summary",
    "Get a summary of the latest completed agent session for an issue. Resolves issue number → workspace → latest session → parsed summary in one call. Shows agent summary text, files touched, commands run, duration, cost, and key excerpts. Complements get_board_status (live state) with completed-work history.",
    {
      issueNumber: z.number().describe("The issue number (e.g. 1, 2, 3)"),
    },
    async ({ issueNumber }) => {
      try {
        // 1. Resolve issue by number
        const issueRows = await db
          .select()
          .from(schema.issues)
          .where(eq(schema.issues.issueNumber, issueNumber))
          .limit(1);

        if (issueRows.length === 0) {
          return { content: [{ type: "text" as const, text: `Issue #${issueNumber} not found` }] };
        }

        const issue = issueRows[0];

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

        // 4. Fetch session messages
        const msgRows = await db
          .select()
          .from(schema.sessionMessages)
          .where(eq(schema.sessionMessages.sessionId, completedSession.id))
          .orderBy(schema.sessionMessages.id);

        // 5. Parse stats
        let stats: Record<string, unknown> | null = null;
        if (completedSession.stats) {
          try { stats = JSON.parse(completedSession.stats); } catch { /* ignore */ }
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
            durationMs: (stats as any).durationMs ?? 0,
            totalCostUsd: (stats as any).totalCostUsd ?? 0,
            inputTokens: (stats as any).inputTokens ?? 0,
            outputTokens: (stats as any).outputTokens ?? 0,
            numTurns: (stats as any).numTurns ?? 1,
            model: (stats as any).model ?? summary.model,
            success: (stats as any).success ?? false,
          } : null,
          ...summary,
        };

        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );
}
