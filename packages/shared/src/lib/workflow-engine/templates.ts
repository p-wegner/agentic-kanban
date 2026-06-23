import { eq, asc, sql } from "drizzle-orm";
import * as schema from "../../schema/index.js";
import type { WorkflowDb } from "./types.js";
import {
  validateTemplateInput,
  type TemplateInput,
  type TemplateNodeInput,
  type TemplateEdgeInput,
} from "./graph-validation.js";

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

/** Replace a template's nodes + edges, remapping client node ids to fresh uuids. */
export async function writeTemplateGraph(
  db: WorkflowDb,
  templateId: string,
  nodes: TemplateNodeInput[],
  edges: TemplateEdgeInput[],
): Promise<void> {
  const now = new Date().toISOString();
  await db.delete(schema.workflowEdges).where(eq(schema.workflowEdges.templateId, templateId));
  await db.delete(schema.workflowNodes).where(eq(schema.workflowNodes.templateId, templateId));
  const idMap = new Map<string, string>();
  let sort = 0;
  for (const n of nodes) {
    const newId = crypto.randomUUID();
    idMap.set(String(n.id), newId);
    await db.insert(schema.workflowNodes).values({
      id: newId,
      templateId,
      name: n.name ?? "Stage",
      nodeType: n.nodeType ?? "normal",
      statusName: n.statusName ?? null,
      skillId: n.skillId ?? null,
      skillName: n.skillName ?? null,
      maxVisits: Number.isFinite(n.maxVisits) ? Number(n.maxVisits) : 0,
      config: n.config ?? null,
      posX: Math.round(n.posX ?? 0),
      posY: Math.round(n.posY ?? 0),
      sortOrder: n.sortOrder ?? sort++,
      createdAt: now,
    });
  }
  let esort = 0;
  for (const e of edges) {
    const from = idMap.get(String(e.fromNodeId));
    const to = idMap.get(String(e.toNodeId));
    if (!from || !to) continue;
    await db.insert(schema.workflowEdges).values({
      id: crypto.randomUUID(),
      templateId,
      fromNodeId: from,
      toNodeId: to,
      label: e.label ?? null,
      condition: e.condition ?? "manual",
      isLoop: !!e.isLoop,
      sortOrder: e.sortOrder ?? esort++,
      createdAt: now,
    });
  }
}

export async function createWorkflowTemplate(
  db: WorkflowDb,
  input: TemplateInput,
): Promise<{ ok: true; id: string } | { ok: false; errors: string[] }> {
  const errors = validateTemplateInput(input);
  if (errors.length > 0 && input.nodes.length > 0) return { ok: false, errors };
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.insert(schema.workflowTemplates).values({
    id,
    projectId: input.projectId,
    name: input.name,
    description: input.description ?? null,
    ticketType: input.ticketType ?? null,
    isDefault: !!input.isDefault,
    isBuiltin: false,
    builtinKey: null,
    createdAt: now,
    updatedAt: now,
  });
  await writeTemplateGraph(db, id, input.nodes, input.edges);
  return { ok: true, id };
}

export async function updateWorkflowTemplate(
  db: WorkflowDb,
  id: string,
  input: Partial<TemplateInput>,
): Promise<{ ok: true } | { ok: false; errors?: string[]; error?: string }> {
  const rows = await db.select().from(schema.workflowTemplates).where(eq(schema.workflowTemplates.id, id)).limit(1);
  if (rows.length === 0) return { ok: false, error: "Template not found" };
  if (rows[0].isBuiltin) return { ok: false, error: "Built-in workflows cannot be edited; duplicate first." };
  if (input.nodes && input.edges) {
    const errors = validateTemplateInput({ nodes: input.nodes, edges: input.edges });
    if (errors.length > 0) return { ok: false, errors };
  }
  const now = new Date().toISOString();
  await db.update(schema.workflowTemplates).set({
    name: input.name ?? rows[0].name,
    description: input.description !== undefined ? input.description : rows[0].description,
    ticketType: input.ticketType !== undefined ? input.ticketType : rows[0].ticketType,
    isDefault: input.isDefault !== undefined ? !!input.isDefault : rows[0].isDefault,
    updatedAt: now,
  }).where(eq(schema.workflowTemplates.id, id));
  if (input.nodes && input.edges) await writeTemplateGraph(db, id, input.nodes, input.edges);
  return { ok: true };
}

export async function deleteWorkflowTemplate(
  db: WorkflowDb,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rows = await db.select().from(schema.workflowTemplates).where(eq(schema.workflowTemplates.id, id)).limit(1);
  if (rows.length === 0) return { ok: false, error: "Template not found" };
  if (rows[0].isBuiltin) return { ok: false, error: "Built-in workflows cannot be deleted." };
  await db.delete(schema.workflowEdges).where(eq(schema.workflowEdges.templateId, id));
  await db.delete(schema.workflowNodes).where(eq(schema.workflowNodes.templateId, id));
  await db.delete(schema.workflowTemplates).where(eq(schema.workflowTemplates.id, id));
  return { ok: true };
}

/** Load a template + its nodes + edges (ordered). Returns null if missing. */
export async function getTemplateGraph(db: WorkflowDb, id: string) {
  const rows = await db.select().from(schema.workflowTemplates).where(eq(schema.workflowTemplates.id, id)).limit(1);
  if (rows.length === 0) return null;
  const nodes = await db.select().from(schema.workflowNodes).where(eq(schema.workflowNodes.templateId, id)).orderBy(asc(schema.workflowNodes.sortOrder));
  const edges = await db.select().from(schema.workflowEdges).where(eq(schema.workflowEdges.templateId, id)).orderBy(asc(schema.workflowEdges.sortOrder));
  return { ...rows[0], nodes, edges };
}

/** List templates available to a project (project-scoped + global built-ins). */
export async function listWorkflowTemplates(db: WorkflowDb, projectId: string) {
  return db
    .select()
    .from(schema.workflowTemplates)
    .where(sql`${schema.workflowTemplates.projectId} = ${projectId} OR ${schema.workflowTemplates.projectId} IS NULL`);
}
