import { and, eq, ne } from "drizzle-orm";
import type { ToolDeps } from "./deps.js";
import { notifyWorkflowAdvanced } from "../notify.js";
import { mcpText, type McpResponse } from "../db-utils.js";
import { computeWorkspaceSignals, proposeTransition } from "@agentic-kanban/shared/lib/workflow-engine";
import type { BoardEventReason } from "@agentic-kanban/shared/lib/board-events-contract";

/**
 * The workflow-advance half that `propose_transition` and `clarify_or_propose` share (#772).
 *
 * Those two tools measured as the single densest clone pair in the whole repo — 349 of
 * propose-transition's 574 token windows also occur in clarify-or-propose — because
 * `clarify_or_propose`'s `action: "propose"` branch IS `propose_transition`, re-typed. Both
 * halves are extracted here:
 *
 *   - `resolveWorkflowWorkspaceId` — explicit workspaceId, else the most recently created
 *     non-closed workspace for the issue. It returns `string | null` rather than an MCP
 *     response so each tool keeps its own wording for the failure (they differ by two words,
 *     and `mcp-error-spelling` cares about the wording).
 *   - `advanceWorkflow` — signals, transition, board notify, fork/join notify, and the
 *     `{movedTo, autoRouted, status, terminal, nextStages}` payload the two tools each wrap in
 *     their own envelope (one adds `guidance`, the other `action: "propose"`).
 *
 * No tool name, description or argument schema changes — this is the body only.
 */
export async function resolveWorkflowWorkspaceId(
  deps: Pick<ToolDeps, "db" | "schema">,
  args: { workspaceId?: string; issueId?: string },
): Promise<string | null> {
  if (args.workspaceId) return args.workspaceId;
  if (!args.issueId) return null;
  const { db, schema } = deps;
  const rows = await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.issueId, args.issueId), ne(schema.workspaces.status, "closed")))
    .orderBy(schema.workspaces.createdAt);
  return rows.length > 0 ? rows[rows.length - 1].id : null;
}

export type WorkflowAdvanceResult =
  | { ok: false; error: McpResponse }
  | {
      ok: true;
      movedTo: string | null | undefined;
      autoRouted: boolean;
      status: string | null | undefined;
      terminal: boolean;
      nextStages: string[];
    };

export async function advanceWorkflow(
  deps: Pick<ToolDeps, "db" | "schema" | "notifyBoard">,
  args: {
    workspaceId: string;
    toNodeId?: string;
    toNodeName?: string;
    summary?: string;
    testsPassed?: boolean;
    reason: BoardEventReason;
    /** Known project id; looked up from the workspace when omitted. */
    projectId?: string;
  },
): Promise<WorkflowAdvanceResult> {
  const { db, schema, notifyBoard } = deps;
  const { workspaceId } = args;

  const signals = await computeWorkspaceSignals(db, workspaceId, { testsPassed: args.testsPassed });

  const result = await proposeTransition(db, {
    workspaceId,
    toNodeId: args.toNodeId,
    toNodeName: args.toNodeName,
    summary: args.summary,
    triggeredBy: "agent",
    signals,
  });

  if (!result.ok) {
    return { ok: false, error: mcpText(result.error ?? "Transition failed.") };
  }

  // Notify the board so the UI reflects the new stage/status.
  let projectId = args.projectId;
  if (!projectId) {
    const issueRows = await db
      .select({ projectId: schema.issues.projectId })
      .from(schema.workspaces)
      .innerJoin(schema.issues, eq(schema.workspaces.issueId, schema.issues.id))
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    projectId = issueRows[0]?.projectId ?? undefined;
  }
  if (projectId) notifyBoard(projectId, args.reason);

  // Trigger fork/join orchestration in the main server (separate process).
  notifyWorkflowAdvanced(workspaceId);

  const nextStages = (result.nextTransitions ?? []).map((t) => t.toNodeName);
  return {
    ok: true,
    movedTo: result.toNode?.name,
    autoRouted: result.autoResolved ?? false,
    status: result.statusName,
    terminal: nextStages.length === 0,
    nextStages,
  };
}
