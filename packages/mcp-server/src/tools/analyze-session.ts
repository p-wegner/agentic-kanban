import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { parseSessionSummary } from "@agentic-kanban/shared";
import { prodDeps, type ToolDeps } from "./deps.js";
import { requireEntity } from "../db-utils.js";

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
 * Mirrors `pnpm cli -- session analyze <session-id>`.
 * Returns a consolidated analysis of a session: workspace, issue, parsed summary
 * (tool patterns, files, commands, errors), and token/cost stats.
 */
export function registerAnalyzeSession(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

  server.tool(
    "analyze_session",
    "Show a consolidated analysis of a session: workspace, issue, parsed summary with tool patterns, stats, and errors. Mirrors `pnpm cli -- session analyze <session-id>`.",
    {
      sessionId: z.string().describe("The board session ID to analyze"),
    },
    async ({ sessionId }) => {
      const sessionRows = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId))
        .limit(1);

      const r = requireEntity(sessionRows, sessionId, "Session");
      if (!r.ok) return r.error;

      const session = r.value;

      // Workspace
      const wsRows = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, session.workspaceId))
        .limit(1);
      const ws = wsRows[0] ?? null;

      // Issue
      let issue: Record<string, unknown> | null = null;
      if (ws) {
        const issueRows = await db
          .select({
            id: schema.issues.id,
            issueNumber: schema.issues.issueNumber,
            title: schema.issues.title,
            statusName: schema.projectStatuses.name,
            priority: schema.issues.priority,
            issueType: schema.issues.issueType,
          })
          .from(schema.issues)
          .innerJoin(schema.projectStatuses, eq(schema.issues.statusId, schema.projectStatuses.id))
          .where(eq(schema.issues.id, ws.issueId))
          .limit(1);
        issue = issueRows[0] ?? null;
      }

      // Session messages for summary
      const msgRows = await db
        .select({ type: schema.sessionMessages.type, data: schema.sessionMessages.data })
        .from(schema.sessionMessages)
        .where(eq(schema.sessionMessages.sessionId, sessionId))
        .orderBy(schema.sessionMessages.id);

      const summary = parseSessionSummary(msgRows);

      // Stats
      let stats: SessionStatsBlob | null = null;
      if (session.stats) {
        try { stats = JSON.parse(session.stats) as SessionStatsBlob; } catch { /* ignore */ }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            session: {
              id: session.id,
              status: session.status,
              startedAt: session.startedAt,
              endedAt: session.endedAt,
              executor: session.executor,
              triggerType: session.triggerType,
            },
            workspace: ws
              ? {
                  id: ws.id,
                  branch: ws.branch,
                  status: ws.status,
                  workingDir: ws.workingDir,
                  isDirect: ws.isDirect,
                }
              : null,
            issue,
            summary,
            stats: stats
              ? {
                  durationMs: stats.durationMs ?? 0,
                  totalCostUsd: stats.totalCostUsd ?? 0,
                  inputTokens: stats.inputTokens ?? 0,
                  outputTokens: stats.outputTokens ?? 0,
                  numTurns: stats.numTurns ?? 1,
                  model: stats.model ?? summary.model,
                  success: stats.success ?? false,
                  agentSummary: stats.agentSummary,
                }
              : null,
          }, null, 2),
        }],
      };
    },
  );
}
