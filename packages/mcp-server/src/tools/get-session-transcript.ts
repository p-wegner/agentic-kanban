import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";
import { requireEntity } from "../db-utils.js";
import { readSessionMessages } from "@agentic-kanban/shared/lib/session-messages";

export function registerGetSessionTranscript(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

  server.tool(
    "get_session_transcript",
    "Retrieve a session transcript by session ID, including project, issue, workspace, session metadata, and ordered messages.",
    {
      sessionId: z.string().describe("The board session ID to retrieve"),
      limit: z.number().int().positive().max(1000).optional().describe("Maximum messages to return, newest messages are selected then returned in chronological order. Defaults to 200."),
    },
    async ({ sessionId, limit }) => {
      const sessionRows = await db
        .select({
          sessionId: schema.sessions.id,
          providerSessionId: schema.sessions.providerSessionId,
          executor: schema.sessions.executor,
          sessionStatus: schema.sessions.status,
          startedAt: schema.sessions.startedAt,
          endedAt: schema.sessions.endedAt,
          exitCode: schema.sessions.exitCode,
          triggerType: schema.sessions.triggerType,
          skillId: schema.sessions.skillId,
          skillName: schema.sessions.skillName,
          workspaceId: schema.workspaces.id,
          branch: schema.workspaces.branch,
          workspaceStatus: schema.workspaces.status,
          issueId: schema.issues.id,
          issueNumber: schema.issues.issueNumber,
          issueTitle: schema.issues.title,
          projectId: schema.projects.id,
          projectName: schema.projects.name,
        })
        .from(schema.sessions)
        .innerJoin(schema.workspaces, eq(schema.sessions.workspaceId, schema.workspaces.id))
        .innerJoin(schema.issues, eq(schema.workspaces.issueId, schema.issues.id))
        .innerJoin(schema.projects, eq(schema.issues.projectId, schema.projects.id))
        .where(eq(schema.sessions.id, sessionId))
        .limit(1);

      const r = requireEntity(sessionRows, sessionId, "Session");
      if (!r.ok) return r.error;

      const messageLimit = limit ?? 200;
      // Prefer .out file for stdout; non-stdout rows from DB; fall back to DB-only for historical sessions
      // exitCode is stored as TEXT in the DB (schema: text("exit_code")), so the Drizzle
      // row type is string | null — match it here rather than number | null.
      // The .out-file-else-DB rule lives in shared (#507), including the DB-path SQL
      // paging this tool relies on for long transcripts.
      const { messages } = await readSessionMessages(db, sessionId, { limit: messageLimit });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ...r.value,
            messages,
          }, null, 2),
        }],
      };
    },
  );
}
