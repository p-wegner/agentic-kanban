import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { prodDeps, type ToolDeps } from "./deps.js";
import { notifyWorkflowAdvanced } from "../notify.js";
import {
  computeWorkspaceSignals,
  proposeTransition,
} from "@agentic-kanban/shared/lib/workflow-engine";

const questionSchema = z.object({
  question: z.string().describe("The question to show the user"),
  header: z.string().optional().describe("Short optional header"),
  multiSelect: z.boolean().optional().describe("Whether multiple options may be selected"),
  options: z.array(z.object({
    label: z.string(),
    description: z.string().optional(),
  })).optional().describe("Optional structured answer choices"),
});

export function registerClarifyOrPropose(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema, notifyBoard } = deps;

  server.tool(
    "clarify_or_propose",
    "For workflow phase skills: either raise a structured clarifying question in the interactive UI, or propose the next workflow gate.",
    {
      action: z.enum(["clarify", "propose"]).describe("clarify: surface questions to the user. propose: advance the workflow gate."),
      workspaceId: z.string().optional().describe("Workspace ID from workflow instructions"),
      issueId: z.string().optional().describe("Issue ID. Used to resolve the active workspace if workspaceId is omitted."),
      questions: z.array(questionSchema).optional().describe("Structured clarifying questions for action=clarify"),
      toNodeName: z.string().optional().describe("Target workflow stage for action=propose"),
      toNodeId: z.string().optional().describe("Target workflow node ID for action=propose"),
      summary: z.string().optional().describe("Short clarification context or transition summary"),
      testsPassed: z.boolean().optional().describe("Whether tests passed; used by action=propose for conditional routing"),
    },
    async ({ action, workspaceId, issueId, questions, toNodeName, toNodeId, summary, testsPassed }) => {
      const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

      let resolvedWorkspaceId = workspaceId;
      if (!resolvedWorkspaceId && issueId) {
        const rows = await db
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(and(eq(schema.workspaces.issueId, issueId), ne(schema.workspaces.status, "closed")))
          .orderBy(schema.workspaces.createdAt);
        if (rows.length > 0) resolvedWorkspaceId = rows[rows.length - 1].id;
      }
      if (!resolvedWorkspaceId) {
        return text("Provide a workspaceId (from workflow instructions) or an issueId with an active workspace.");
      }

      const wsRows = await db
        .select({
          issueId: schema.workspaces.issueId,
          projectId: schema.issues.projectId,
          issueNumber: schema.issues.issueNumber,
          issueTitle: schema.issues.title,
        })
        .from(schema.workspaces)
        .innerJoin(schema.issues, eq(schema.workspaces.issueId, schema.issues.id))
        .where(eq(schema.workspaces.id, resolvedWorkspaceId))
        .limit(1);
      const ws = wsRows[0];
      if (!ws) return text(`Workspace not found: ${resolvedWorkspaceId}`);

      if (action === "clarify") {
        const normalized = (questions ?? []).map((question) => ({
          ...question,
          question: question.question.trim(),
          options: (question.options && question.options.length > 0)
            ? question.options
            : [{ label: "Answer in free text" }],
        })).filter((question) => question.question.length > 0);
        if (normalized.length === 0) return text("questions[] is required for action=clarify");

        const toolUseId = `mcp-clarify-${randomUUID()}`;
        const body = [
          summary?.trim() || "The phase agent needs clarification before continuing.",
          "",
          ...normalized.map((q, i) => `${i + 1}. ${q.header ? `${q.header}: ` : ""}${q.question}`),
        ].join("\n");
        await db.insert(schema.issueComments).values({
          id: randomUUID(),
          issueId: ws.issueId,
          workspaceId: resolvedWorkspaceId,
          kind: "agent-question",
          author: "agent",
          body,
          payload: JSON.stringify({ toolUseId, questions: normalized, source: "mcp_clarify_or_propose" }),
          createdAt: new Date().toISOString(),
        });
        notifyBoard(ws.projectId, "mcp_clarifying_question");
        return text(JSON.stringify({
          ok: true,
          action: "clarify",
          toolUseId,
          workspaceId: resolvedWorkspaceId,
          issueId: ws.issueId,
          issueNumber: ws.issueNumber,
          questions: normalized,
          guidance: "The question is now visible in the interactive UI. Stop and wait for the user to answer.",
        }, null, 2));
      }

      const signals = await computeWorkspaceSignals(db, resolvedWorkspaceId, { testsPassed });
      const result = await proposeTransition(db, {
        workspaceId: resolvedWorkspaceId,
        toNodeId,
        toNodeName,
        summary,
        triggeredBy: "agent",
        signals,
      });
      if (!result.ok) return text(result.error ?? "Transition failed.");

      notifyBoard(ws.projectId, "mcp_clarify_or_propose_transition");
      notifyWorkflowAdvanced(resolvedWorkspaceId);

      const next = (result.nextTransitions ?? []).map((t) => t.toNodeName);
      return text(JSON.stringify({
        ok: true,
        action: "propose",
        movedTo: result.toNode?.name,
        autoRouted: result.autoResolved ?? false,
        status: result.statusName,
        terminal: next.length === 0,
        nextStages: next,
      }, null, 2));
    },
  );
}
