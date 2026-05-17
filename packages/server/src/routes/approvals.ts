import { Hono } from "hono";
import { createApproval, getApproval, resolveApproval, deleteApproval, type ApprovalDecision } from "../services/approvals.js";
import type { BoardEvents } from "../services/board-events.js";
import { db } from "../db/index.js";
import { sessions, workspaces, issues } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";

export function createApprovalsRoute(boardEvents: BoardEvents) {
  const app = new Hono();

  // Create a new approval request (called by MCP approve_tool_use tool)
  app.post("/", async (c) => {
    const body = await c.req.json<{ sessionId: string; toolName: string; toolInput: unknown }>();

    // Resolve projectId from sessionId for WS broadcast
    let projectId: string | undefined;
    let workspaceId: string | undefined;
    try {
      const sessionRows = await db.select({ workspaceId: sessions.workspaceId })
        .from(sessions)
        .where(eq(sessions.id, body.sessionId))
        .limit(1);
      if (sessionRows.length > 0) {
        workspaceId = sessionRows[0].workspaceId;
        if (workspaceId) {
          const wsRows = await db.select({ issueId: workspaces.issueId })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1);
          if (wsRows.length > 0) {
            const issueRows = await db.select({ projectId: issues.projectId })
              .from(issues)
              .where(eq(issues.id, wsRows[0].issueId))
              .limit(1);
            if (issueRows.length > 0) projectId = issueRows[0].projectId;
          }
        }
      }
    } catch {
      // continue without projectId — approval still works, just no WS broadcast
    }

    const approval = createApproval({ sessionId: body.sessionId, toolName: body.toolName, toolInput: body.toolInput, workspaceId, projectId });

    if (projectId) {
      boardEvents.broadcastApprovalRequest(projectId, approval);
    }

    return c.json({ id: approval.id });
  });

  // Get approval status (polled by MCP tool)
  app.get("/:id", (c) => {
    const approval = getApproval(c.req.param("id"));
    if (!approval) return c.json({ error: "not found" }, 404);
    return c.json({ id: approval.id, decision: approval.decision ?? null });
  });

  // Resolve approval (called by UI)
  app.put("/:id", async (c) => {
    const body = await c.req.json<{ decision: ApprovalDecision }>();
    const ok = resolveApproval(c.req.param("id"), body.decision);
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  // Clean up after MCP tool is done
  app.delete("/:id", (c) => {
    deleteApproval(c.req.param("id"));
    return c.json({ ok: true });
  });

  return app;
}
