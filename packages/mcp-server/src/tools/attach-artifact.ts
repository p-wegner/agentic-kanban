import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { prodDeps, type ToolDeps } from "./deps.js";

const ARTIFACT_TYPES = ["text", "link", "image"] as const;

export function registerAttachArtifact(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema, notifyBoard } = deps;

  server.tool(
    "attach_artifact",
    "Attach a text, link, or image artifact to an issue or workspace. Workspace artifacts are also tied to the workspace's issue.",
    {
      issueId: z.string().optional().describe("Issue ID to attach to. Required unless workspaceId is provided."),
      workspaceId: z.string().optional().describe("Workspace ID to attach to. When provided without issueId, the issue is resolved from the workspace."),
      type: z.enum(ARTIFACT_TYPES).describe("Artifact type: text, link, or image"),
      content: z.string().describe("Text content, URL, or base64/data URL image content"),
      mimeType: z.string().optional().describe("Optional MIME type, e.g. text/markdown or image/png"),
      caption: z.string().optional().describe("Optional short caption. Phase artifacts should use phase-artifact:<phase>."),
    },
    async ({ issueId, workspaceId, type, content, mimeType, caption }) => {
      const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

      if (!issueId && !workspaceId) return text("Error: issueId or workspaceId is required");
      if (!content.trim()) return text("Error: content is required");

      let resolvedIssueId = issueId;
      let projectId: string | null = null;

      if (workspaceId) {
        const rows = await db
          .select({ issueId: schema.workspaces.issueId, projectId: schema.issues.projectId })
          .from(schema.workspaces)
          .innerJoin(schema.issues, eq(schema.workspaces.issueId, schema.issues.id))
          .where(eq(schema.workspaces.id, workspaceId))
          .limit(1);
        const ws = rows[0];
        if (!ws) return text(`Error: workspace not found: ${workspaceId}`);
        if (resolvedIssueId && resolvedIssueId !== ws.issueId) {
          return text("Error: workspaceId does not belong to issueId");
        }
        resolvedIssueId = ws.issueId;
        projectId = ws.projectId;
      }

      if (!resolvedIssueId) return text("Error: issueId could not be resolved");

      if (!projectId) {
        const rows = await db
          .select({ projectId: schema.issues.projectId })
          .from(schema.issues)
          .where(eq(schema.issues.id, resolvedIssueId))
          .limit(1);
        if (!rows[0]) return text(`Error: issue not found: ${resolvedIssueId}`);
        projectId = rows[0].projectId;
      }

      if (workspaceId) {
        const rows = await db
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.issueId, resolvedIssueId)))
          .limit(1);
        if (!rows[0]) return text("Error: workspaceId does not belong to issueId");
      }

      const id = randomUUID();
      await db.insert(schema.issueArtifacts).values({
        id,
        issueId: resolvedIssueId,
        workspaceId: workspaceId ?? null,
        type,
        mimeType: mimeType ?? null,
        content,
        caption: caption ?? null,
      });

      notifyBoard(projectId, "mcp_attach_artifact");

      return text(JSON.stringify({
        id,
        issueId: resolvedIssueId,
        workspaceId: workspaceId ?? null,
        type,
        mimeType: mimeType ?? null,
        caption: caption ?? null,
      }, null, 2));
    },
  );
}
