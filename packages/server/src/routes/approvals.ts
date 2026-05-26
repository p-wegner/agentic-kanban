import { Hono } from "hono";
import { createApproval, getApproval, resolveApproval, deleteApproval, resolveApprovalContext, type ApprovalDecision } from "../services/approvals.js";
import type { BoardEvents } from "../services/board-events.js";

export function createApprovalsRoute(boardEvents: BoardEvents) {
  const app = new Hono();

  // Create a new approval request (called by MCP approve_tool_use tool)
  app.post("/", async (c) => {
    const body = await c.req.json<{ sessionId: string; toolName: string; toolInput: unknown }>();

    const { workspaceId, projectId } = await resolveApprovalContext(body.sessionId);

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
