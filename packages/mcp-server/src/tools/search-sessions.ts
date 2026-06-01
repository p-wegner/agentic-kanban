import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const SNIPPET_RADIUS = 80;

function makeSnippet(text: string, matchIdx: number): string {
  const start = Math.max(0, matchIdx - SNIPPET_RADIUS);
  const end = Math.min(text.length, matchIdx + SNIPPET_RADIUS);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet += "...";
  return snippet;
}

export function registerSearchSessions(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

  server.tool(
    "search_sessions",
    "Search agent session transcripts globally or within a project/issue. Use this to answer questions like how ticket ak287 was implemented and what problems the agent hit.",
    {
      query: z.string().describe("Case-insensitive text to search for in session messages"),
      projectId: z.string().optional().describe("Optional project ID to restrict the search"),
      issueNumber: z.number().int().positive().optional().describe("Optional issue number to restrict the search"),
      provider: z.string().optional().describe("Optional executor/provider filter, e.g. claude-code, codex, copilot"),
      status: z.string().optional().describe("Optional issue status name filter, e.g. Done or In Progress"),
      limit: z.number().int().positive().max(MAX_LIMIT).optional().describe(`Maximum results to return. Defaults to ${DEFAULT_LIMIT}.`),
    },
    async ({ query, projectId, issueNumber, provider, status, limit }) => {
      const q = query.trim();
      if (q.length < 2) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ results: [], totalMatches: 0 }, null, 2) }] };
      }

      const conditions = [
        sql`${schema.sessionMessages.data} IS NOT NULL`,
        sql`${schema.sessionMessages.data} LIKE ${"%" + q + "%"}`,
        sql`${schema.sessionMessages.type} != 'exit'`,
      ];
      if (projectId) conditions.push(eq(schema.issues.projectId, projectId));
      if (issueNumber) conditions.push(eq(schema.issues.issueNumber, issueNumber));
      if (provider) conditions.push(eq(schema.sessions.executor, provider));
      if (status) conditions.push(eq(schema.projectStatuses.name, status));

      const rows = await db
        .select({
          messageId: schema.sessionMessages.id,
          messageData: schema.sessionMessages.data,
          messageCreatedAt: schema.sessionMessages.createdAt,
          sessionId: schema.sessions.id,
          providerSessionId: schema.sessions.providerSessionId,
          sessionStartedAt: schema.sessions.startedAt,
          sessionStatus: schema.sessions.status,
          executor: schema.sessions.executor,
          workspaceId: schema.workspaces.id,
          branch: schema.workspaces.branch,
          issueId: schema.issues.id,
          issueNumber: schema.issues.issueNumber,
          issueTitle: schema.issues.title,
          issueStatusName: schema.projectStatuses.name,
          projectId: schema.projects.id,
          projectName: schema.projects.name,
        })
        .from(schema.sessionMessages)
        .innerJoin(schema.sessions, eq(schema.sessionMessages.sessionId, schema.sessions.id))
        .innerJoin(schema.workspaces, eq(schema.sessions.workspaceId, schema.workspaces.id))
        .innerJoin(schema.issues, eq(schema.workspaces.issueId, schema.issues.id))
        .innerJoin(schema.projects, eq(schema.issues.projectId, schema.projects.id))
        .innerJoin(schema.projectStatuses, eq(schema.issues.statusId, schema.projectStatuses.id))
        .where(and(...conditions))
        .orderBy(desc(schema.sessionMessages.id))
        .limit(limit ?? DEFAULT_LIMIT);

      const results = rows.map((row) => {
        const data = row.messageData ?? "";
        const matchOffset = data.toLowerCase().indexOf(q.toLowerCase());
        return {
          messageId: row.messageId,
          sessionId: row.sessionId,
          providerSessionId: row.providerSessionId,
          snippet: makeSnippet(data, matchOffset >= 0 ? matchOffset : 0),
          matchOffset,
          messageCreatedAt: row.messageCreatedAt,
          projectId: row.projectId,
          projectName: row.projectName,
          issueId: row.issueId,
          issueNumber: row.issueNumber,
          issueTitle: row.issueTitle,
          issueStatusName: row.issueStatusName,
          workspaceId: row.workspaceId,
          branch: row.branch,
          sessionStartedAt: row.sessionStartedAt,
          sessionStatus: row.sessionStatus,
          executor: row.executor,
        };
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ results, totalMatches: results.length }, null, 2),
        }],
      };
    },
  );
}
