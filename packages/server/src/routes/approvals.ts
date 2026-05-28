import { createApproval, getApproval, resolveApproval, deleteApproval, resolveApprovalContext, type ApprovalDecision } from "../services/approvals.js";
import type { BoardEvents } from "../services/board-events.js";
import { emitButlerSystemEvent } from "../services/butler-event-feed.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";

export function createApprovalsRoute(boardEvents: BoardEvents) {
  const app = createRouter();

  // Create a new approval request (called by MCP approve_tool_use tool)
  app.post("/", async (c) => {
    const body = await parseJsonBody<{ sessionId: string; toolName: string; toolInput: unknown }>(c);

    const { workspaceId, projectId } = await resolveApprovalContext(body.sessionId);

    const approval = createApproval({ sessionId: body.sessionId, toolName: body.toolName, toolInput: body.toolInput, workspaceId, projectId });

    if (projectId) {
      boardEvents.broadcastApprovalRequest(projectId, approval);
      emitButlerSystemEvent({ projectId, kind: "permission_pending", workspaceId, text: `Agent in workspace ${workspaceId ?? "?"} is requesting permission for tool "${body.toolName}" — needs user approval.` });
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
    const body = await parseJsonBody<{ decision: ApprovalDecision }>(c);
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
