import { and, eq, asc, sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../schema/index.js";

/**
 * Workflow engine — the single source of truth for resolving an issue's
 * workflow template, tracking which node a workspace is on, validating
 * transitions, and keeping the legacy board `status` in sync (derived from the
 * current node's `statusName`).
 *
 * All functions take the drizzle `db` as their first argument so the server,
 * the MCP server, and tests can share one implementation (mirrors the
 * git-service "single source of truth" pattern).
 */

export type WorkflowDb = LibSQLDatabase<typeof schema>;

export interface WorkflowNodeRow {
  id: string;
  templateId: string;
  name: string;
  nodeType: string;
  statusName: string | null;
  skillId: string | null;
  skillName: string | null;
  maxVisits: number;
  config: string | null;
  sortOrder: number;
}

export interface TransitionTarget {
  edgeId: string;
  toNodeId: string;
  toNodeName: string;
  toStatusName: string | null;
  label: string | null;
  condition: string;
}

/** Parse the `guidance` string out of a node's JSON config, if present. */
export function getNodeGuidance(config: string | null): string | null {
  if (!config) return null;
  try {
    const parsed = JSON.parse(config) as { guidance?: string };
    return parsed.guidance ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve which workflow template an issue should use, in priority order:
 *  1. An explicit template id (validated against project/global scope),
 *  2. The project-scoped default for the issue's ticket type,
 *  3. A global built-in default for the ticket type,
 *  4. The global default template (Simple Ticket),
 *  5. null (legacy status-only flow).
 */
export async function resolveTemplateForIssue(
  db: WorkflowDb,
  opts: { projectId: string; issueType?: string | null; explicitTemplateId?: string | null },
): Promise<string | null> {
  const { projectId, issueType, explicitTemplateId } = opts;

  if (explicitTemplateId) {
    const rows = await db
      .select({ id: schema.workflowTemplates.id, projectId: schema.workflowTemplates.projectId })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, explicitTemplateId))
      .limit(1);
    if (rows.length > 0 && (rows[0].projectId === null || rows[0].projectId === projectId)) {
      return rows[0].id;
    }
  }

  // Candidate templates: project-scoped first, then global built-ins.
  const candidates = await db
    .select({
      id: schema.workflowTemplates.id,
      projectId: schema.workflowTemplates.projectId,
      ticketType: schema.workflowTemplates.ticketType,
      isDefault: schema.workflowTemplates.isDefault,
      isBuiltin: schema.workflowTemplates.isBuiltin,
      builtinKey: schema.workflowTemplates.builtinKey,
    })
    .from(schema.workflowTemplates)
    .where(
      sql`${schema.workflowTemplates.projectId} = ${projectId} OR ${schema.workflowTemplates.projectId} IS NULL`,
    );

  const projectScoped = candidates.filter((c) => c.projectId === projectId);
  const global = candidates.filter((c) => c.projectId === null);

  // 2 + 3: default for this ticket type (project scope wins over global).
  if (issueType) {
    const byType = (list: typeof candidates) =>
      list.find((c) => c.ticketType === issueType && c.isDefault);
    const match = byType(projectScoped) ?? byType(global);
    if (match) return match.id;
  }

  // 4: the global Simple Ticket default (ticketType null, isDefault true).
  const simpleDefault =
    projectScoped.find((c) => c.isDefault && !c.ticketType) ??
    global.find((c) => c.builtinKey === "simple-ticket") ??
    global.find((c) => c.isDefault && !c.ticketType);
  return simpleDefault?.id ?? null;
}

/** The start node of a template (nodeType 'start', or lowest sortOrder fallback). */
export async function getStartNode(
  db: WorkflowDb,
  templateId: string,
): Promise<WorkflowNodeRow | null> {
  const nodes = await db
    .select()
    .from(schema.workflowNodes)
    .where(eq(schema.workflowNodes.templateId, templateId))
    .orderBy(asc(schema.workflowNodes.sortOrder));
  if (nodes.length === 0) return null;
  return (nodes.find((n) => n.nodeType === "start") ?? nodes[0]) as WorkflowNodeRow;
}

export async function getNode(db: WorkflowDb, nodeId: string): Promise<WorkflowNodeRow | null> {
  const rows = await db
    .select()
    .from(schema.workflowNodes)
    .where(eq(schema.workflowNodes.id, nodeId))
    .limit(1);
  return (rows[0] as WorkflowNodeRow) ?? null;
}

/** Valid outgoing transitions from a node (with target node + status info). */
export async function getOutgoingTransitions(
  db: WorkflowDb,
  nodeId: string,
): Promise<TransitionTarget[]> {
  const rows = await db
    .select({
      edgeId: schema.workflowEdges.id,
      toNodeId: schema.workflowEdges.toNodeId,
      label: schema.workflowEdges.label,
      condition: schema.workflowEdges.condition,
      sortOrder: schema.workflowEdges.sortOrder,
      toNodeName: schema.workflowNodes.name,
      toStatusName: schema.workflowNodes.statusName,
    })
    .from(schema.workflowEdges)
    .innerJoin(schema.workflowNodes, eq(schema.workflowEdges.toNodeId, schema.workflowNodes.id))
    .where(eq(schema.workflowEdges.fromNodeId, nodeId))
    .orderBy(asc(schema.workflowEdges.sortOrder));
  return rows.map((r) => ({
    edgeId: r.edgeId,
    toNodeId: r.toNodeId,
    toNodeName: r.toNodeName,
    toStatusName: r.toStatusName,
    label: r.label,
    condition: r.condition,
  }));
}

/** How many times a workspace has already entered a given node (for maxVisits). */
export async function countNodeVisits(
  db: WorkflowDb,
  workspaceId: string,
  nodeId: string,
): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)` })
    .from(schema.workflowTransitions)
    .where(
      and(
        eq(schema.workflowTransitions.workspaceId, workspaceId),
        eq(schema.workflowTransitions.toNodeId, nodeId),
      ),
    );
  return Number(rows[0]?.c ?? 0);
}

/** Resolve a project's status row id by its (case-insensitive) name. */
export async function resolveStatusId(
  db: WorkflowDb,
  projectId: string,
  statusName: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: schema.projectStatuses.id, name: schema.projectStatuses.name })
    .from(schema.projectStatuses)
    .where(eq(schema.projectStatuses.projectId, projectId));
  const match =
    rows.find((r) => r.name === statusName) ??
    rows.find((r) => r.name.toLowerCase() === statusName.toLowerCase());
  return match?.id ?? null;
}

/**
 * Render the block injected into the agent prompt describing where it is in the
 * workflow and how to advance. Returns "" when there is no active workflow.
 */
export function buildTransitionBlock(
  node: WorkflowNodeRow,
  transitions: TransitionTarget[],
  workspaceId?: string,
): string {
  const guidance = getNodeGuidance(node.config);
  const wsArg = workspaceId ? `workspaceId: "${workspaceId}", ` : "workspaceId, ";
  const lines: string[] = [];
  lines.push("## Workflow");
  lines.push(
    `You are at the **${node.name}** stage of this issue's workflow. The board status reflects this stage automatically.`,
  );
  if (guidance) lines.push("", guidance);

  if (transitions.length === 0) {
    lines.push("", "This is a terminal stage — there are no further transitions.");
  } else {
    lines.push("", "When this stage's work is complete, advance the workflow by calling the MCP tool:");
    lines.push(`\`propose_transition({ ${wsArg}toNodeName, summary })\``);
    lines.push("", "Valid next stages from here:");
    for (const t of transitions) {
      const cond = t.condition === "manual" ? "" : ` _(auto: ${t.condition})_`;
      const why = t.label ? ` — ${t.label}` : "";
      lines.push(`- **${t.toNodeName}**${why}${cond}`);
    }
    lines.push(
      "",
      "Do not move the issue with `move_issue`; use `propose_transition` so the workflow stays consistent.",
    );
  }
  return lines.join("\n");
}

export interface ProposeResult {
  ok: boolean;
  error?: string;
  toNode?: WorkflowNodeRow;
  statusName?: string | null;
  statusId?: string | null;
  /** Outgoing transitions from the new node (for re-injection). */
  nextTransitions?: TransitionTarget[];
}

/**
 * Advance a workspace to a new node along a valid edge from its current node.
 * Enforces maxVisits, records the transition, updates workspace.currentNodeId
 * and the issue's currentNodeId + derived status.
 */
export async function proposeTransition(
  db: WorkflowDb,
  opts: {
    workspaceId: string;
    toNodeId?: string;
    toNodeName?: string;
    summary?: string;
    triggeredBy?: string;
  },
): Promise<ProposeResult> {
  const { workspaceId, toNodeId, toNodeName, summary, triggeredBy = "agent" } = opts;

  const wsRows = await db
    .select({
      id: schema.workspaces.id,
      issueId: schema.workspaces.issueId,
      currentNodeId: schema.workspaces.currentNodeId,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  if (wsRows.length === 0) return { ok: false, error: `Workspace ${workspaceId} not found` };
  const ws = wsRows[0];

  if (!ws.currentNodeId) {
    return { ok: false, error: "This workspace is not running a workflow (no current node)." };
  }

  const transitions = await getOutgoingTransitions(db, ws.currentNodeId);
  let target: TransitionTarget | undefined;
  if (toNodeId) {
    target = transitions.find((t) => t.toNodeId === toNodeId);
  } else if (toNodeName) {
    target =
      transitions.find((t) => t.toNodeName === toNodeName) ??
      transitions.find((t) => t.toNodeName.toLowerCase() === toNodeName.toLowerCase());
  }
  if (!target) {
    const valid = transitions.map((t) => t.toNodeName).join(", ") || "(none — terminal stage)";
    return {
      ok: false,
      error: `No valid transition to "${toNodeName ?? toNodeId}" from the current stage. Valid next stages: ${valid}`,
    };
  }

  const toNode = await getNode(db, target.toNodeId);
  if (!toNode) return { ok: false, error: `Target node ${target.toNodeId} not found` };

  // Cycle protection.
  if (toNode.maxVisits > 0) {
    const visits = await countNodeVisits(db, workspaceId, toNode.id);
    if (visits >= toNode.maxVisits) {
      return {
        ok: false,
        error: `Node "${toNode.name}" has reached its visit budget (${toNode.maxVisits}). Escalate to a human instead of looping further.`,
      };
    }
  }

  const now = new Date().toISOString();

  // Resolve the issue's project to map statusName → statusId.
  const issueRows = await db
    .select({ id: schema.issues.id, projectId: schema.issues.projectId })
    .from(schema.issues)
    .where(eq(schema.issues.id, ws.issueId))
    .limit(1);
  const issue = issueRows[0];

  let statusId: string | null = null;
  if (issue && toNode.statusName) {
    statusId = await resolveStatusId(db, issue.projectId, toNode.statusName);
  }

  // Record the transition (history → analytics + progress + visit counting).
  await db.insert(schema.workflowTransitions).values({
    id: crypto.randomUUID(),
    workspaceId,
    fromNodeId: ws.currentNodeId,
    toNodeId: toNode.id,
    summary: summary ?? null,
    triggeredBy,
    createdAt: now,
  });

  await db
    .update(schema.workspaces)
    .set({ currentNodeId: toNode.id, updatedAt: now })
    .where(eq(schema.workspaces.id, workspaceId));

  if (issue) {
    const issueUpdate: Record<string, unknown> = { currentNodeId: toNode.id, updatedAt: now };
    if (statusId) {
      issueUpdate.statusId = statusId;
      issueUpdate.statusChangedAt = now;
    }
    await db.update(schema.issues).set(issueUpdate).where(eq(schema.issues.id, issue.id));
  }

  const nextTransitions = await getOutgoingTransitions(db, toNode.id);
  return { ok: true, toNode, statusName: toNode.statusName, statusId, nextTransitions };
}

/**
 * Read-only resolution of an issue's workflow start node + its transitions,
 * for building the agent prompt / choosing the node's skill BEFORE the
 * workspace row exists. Returns null when the issue has no workflow.
 */
export async function resolveWorkflowStart(
  db: WorkflowDb,
  issueId: string,
): Promise<{ templateId: string; node: WorkflowNodeRow; transitions: TransitionTarget[] } | null> {
  const issueRows = await db
    .select({
      projectId: schema.issues.projectId,
      issueType: schema.issues.issueType,
      workflowTemplateId: schema.issues.workflowTemplateId,
    })
    .from(schema.issues)
    .where(eq(schema.issues.id, issueId))
    .limit(1);
  if (issueRows.length === 0) return null;
  const issue = issueRows[0];

  const templateId = await resolveTemplateForIssue(db, {
    projectId: issue.projectId,
    issueType: issue.issueType,
    explicitTemplateId: issue.workflowTemplateId,
  });
  if (!templateId) return null;

  const node = await getStartNode(db, templateId);
  if (!node) return null;

  const transitions = await getOutgoingTransitions(db, node.id);
  return { templateId, node, transitions };
}

/**
 * Initialise the workflow for a freshly created workspace: resolve the issue's
 * template (persisting it on the issue if not already set), place the workspace
 * on the start node, record the initial transition, and sync the issue status.
 *
 * Returns the start node + its transitions so the caller can inject guidance
 * into the agent prompt. Returns null when the issue has no workflow.
 */
export async function initWorkspaceWorkflow(
  db: WorkflowDb,
  opts: { workspaceId: string; issueId: string },
): Promise<{ node: WorkflowNodeRow; transitions: TransitionTarget[] } | null> {
  const { workspaceId, issueId } = opts;
  const issueRows = await db
    .select({
      id: schema.issues.id,
      projectId: schema.issues.projectId,
      issueType: schema.issues.issueType,
      workflowTemplateId: schema.issues.workflowTemplateId,
    })
    .from(schema.issues)
    .where(eq(schema.issues.id, issueId))
    .limit(1);
  if (issueRows.length === 0) return null;
  const issue = issueRows[0];

  const templateId = await resolveTemplateForIssue(db, {
    projectId: issue.projectId,
    issueType: issue.issueType,
    explicitTemplateId: issue.workflowTemplateId,
  });
  if (!templateId) return null;

  const startNode = await getStartNode(db, templateId);
  if (!startNode) return null;

  const now = new Date().toISOString();

  // Persist the resolved template + current node on the issue.
  const issueUpdate: Record<string, unknown> = {
    workflowTemplateId: templateId,
    currentNodeId: startNode.id,
    updatedAt: now,
  };
  if (startNode.statusName) {
    const statusId = await resolveStatusId(db, issue.projectId, startNode.statusName);
    if (statusId) {
      issueUpdate.statusId = statusId;
      issueUpdate.statusChangedAt = now;
    }
  }
  await db.update(schema.issues).set(issueUpdate).where(eq(schema.issues.id, issueId));

  await db
    .update(schema.workspaces)
    .set({ currentNodeId: startNode.id, updatedAt: now })
    .where(eq(schema.workspaces.id, workspaceId));

  await db.insert(schema.workflowTransitions).values({
    id: crypto.randomUUID(),
    workspaceId,
    fromNodeId: null,
    toNodeId: startNode.id,
    summary: "Workspace started",
    triggeredBy: "system",
    createdAt: now,
  });

  const transitions = await getOutgoingTransitions(db, startNode.id);
  return { node: startNode, transitions };
}
