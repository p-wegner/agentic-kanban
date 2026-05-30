import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import {
  workflowTemplates,
  workflowNodes,
  workflowEdges,
  workflowTransitions,
  issues,
  workspaces,
} from "@agentic-kanban/shared/schema";
import { eq, asc, sql } from "drizzle-orm";
import {
  createWorkflowTemplate,
  proposeTransition,
  resolveTemplateForIssue,
  getOutgoingTransitions,
  validateGraph,
  writeTemplateGraph,
  computeWorkspaceSignals,
  evaluateCondition,
} from "@agentic-kanban/shared/lib/workflow-engine";
import { randomUUID } from "node:crypto";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import type { BoardEvents } from "../services/board-events.js";

interface WorkflowsRouteOptions {
  boardEvents?: BoardEvents;
  /** Hook to run fork/join orchestration after a transition. */
  onWorkflowAdvanced?: (workspaceId: string) => void;
}

interface WorkflowTemplateJson {
  version: number;
  exportedAt: string;
  metadata: {
    id: string;
    name: string;
    description: string | null;
    ticketType: string | null;
    isDefault: boolean;
    isBuiltin: boolean;
    builtinKey: string | null;
    projectId: string | null;
    createdAt: string;
    updatedAt: string;
  };
  nodes: unknown[];
  edges: unknown[];
}

function toTemplateJson(template: any, graph: { nodes: unknown[]; edges: unknown[] }): WorkflowTemplateJson {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    metadata: {
      id: template.id,
      name: template.name,
      description: template.description ?? null,
      ticketType: template.ticketType ?? null,
      isDefault: !!template.isDefault,
      isBuiltin: !!template.isBuiltin,
      builtinKey: template.builtinKey ?? null,
      projectId: template.projectId ?? null,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    },
    nodes: graph.nodes,
    edges: graph.edges,
  };
}

function normalizeImportedTemplate(input: any) {
  const source = input?.template ?? input?.workflow ?? input;
  const metadata = source?.metadata ?? source ?? {};
  return {
    name: input?.name ?? source?.name ?? metadata.name,
    description: input?.description ?? source?.description ?? metadata.description ?? null,
    ticketType: input?.ticketType ?? source?.ticketType ?? metadata.ticketType ?? null,
    isDefault: input?.isDefault ?? source?.isDefault ?? metadata.isDefault ?? false,
    nodes: source?.nodes ?? [],
    edges: source?.edges ?? [],
  };
}

function validateImportedTemplate(spec: ReturnType<typeof normalizeImportedTemplate>): string[] {
  const errors: string[] = [];
  if (typeof spec.name !== "string" || spec.name.trim().length === 0) {
    errors.push("Imported workflow name is required.");
  }
  if (!Array.isArray(spec.nodes)) {
    errors.push("Imported workflow nodes must be an array.");
  }
  if (!Array.isArray(spec.edges)) {
    errors.push("Imported workflow edges must be an array.");
  }
  return errors;
}

/** Load a template's nodes + edges as a graph payload. */
async function loadGraph(database: Database, templateId: string) {
  const [nodes, edges] = await Promise.all([
    database
      .select()
      .from(workflowNodes)
      .where(eq(workflowNodes.templateId, templateId))
      .orderBy(asc(workflowNodes.sortOrder)),
    database
      .select()
      .from(workflowEdges)
      .where(eq(workflowEdges.templateId, templateId))
      .orderBy(asc(workflowEdges.sortOrder)),
  ]);
  return { nodes, edges };
}

export function createWorkflowsRoute(database: Database = db, options?: WorkflowsRouteOptions) {
  const router = createRouter();
  const boardEvents = options?.boardEvents;
  const onWorkflowAdvanced = options?.onWorkflowAdvanced;

  // GET /api/workflows/templates?projectId=&ticketType=&graph=1
  // Lists global + project-scoped templates; ?graph=1 embeds nodes + edges.
  router.get("/templates", async (c) => {
    const projectId = c.req.query("projectId");
    const ticketType = c.req.query("ticketType");
    const withGraph = c.req.query("graph") === "1";

    const rows = await database
      .select()
      .from(workflowTemplates)
      .where(
        projectId
          ? sql`${workflowTemplates.projectId} = ${projectId} OR ${workflowTemplates.projectId} IS NULL`
          : sql`1 = 1`,
      );

    let filtered = rows;
    if (ticketType) {
      filtered = rows.filter((r) => r.ticketType === ticketType || r.ticketType === null);
    }

    if (!withGraph) {
      return c.json(filtered);
    }
    const withGraphs = await Promise.all(
      filtered.map(async (t) => ({ ...t, ...(await loadGraph(database, t.id)) })),
    );
    return c.json(withGraphs);
  });

  // GET /api/workflows/templates/:id — full graph for one template.
  router.get("/templates/:id", async (c) => {
    const id = c.req.param("id");
    const rows = await database
      .select()
      .from(workflowTemplates)
      .where(eq(workflowTemplates.id, id))
      .limit(1);
    if (rows.length === 0) return c.json({ error: "Template not found" }, 404);
    const graph = await loadGraph(database, id);
    return c.json({ ...rows[0], ...graph });
  });

  // GET /api/workflows/templates/:id/export — JSON envelope suitable for import.
  router.get("/templates/:id/export", async (c) => {
    const id = c.req.param("id");
    const rows = await database
      .select()
      .from(workflowTemplates)
      .where(eq(workflowTemplates.id, id))
      .limit(1);
    if (rows.length === 0) return c.json({ error: "Template not found" }, 404);
    const graph = await loadGraph(database, id);
    return c.json(toTemplateJson(rows[0], graph));
  });

  // POST /api/workflows/templates — create a template (optionally cloning another).
  router.post("/templates", async (c) => {
    const body = await parseJsonBody(c);
    const { projectId, name, description, ticketType, isDefault, nodes = [], edges = [], cloneFrom } = body as any;
    if (!projectId) return c.json({ error: "projectId is required" }, 400);

    let srcNodes = nodes;
    let srcEdges = edges;
    let tplName = name;
    let tplDesc = description;
    let tplType = ticketType ?? null;
    if (cloneFrom) {
      const src = await database.select().from(workflowTemplates).where(eq(workflowTemplates.id, cloneFrom)).limit(1);
      if (src.length === 0) return c.json({ error: "cloneFrom template not found" }, 404);
      const g = await loadGraph(database, cloneFrom);
      srcNodes = g.nodes.map((n) => ({ ...n }));
      srcEdges = g.edges.map((e) => ({ ...e }));
      tplName = name ?? `${src[0].name} (copy)`;
      tplDesc = description ?? src[0].description;
      tplType = ticketType ?? null; // a copy is not auto-default
    }
    if (!tplName) return c.json({ error: "name is required" }, 400);

    const errors = validateGraph(
      srcNodes.map((n: any) => ({ id: String(n.id), name: n.name, nodeType: n.nodeType })),
      srcEdges.map((e: any) => ({ fromNodeId: String(e.fromNodeId), toNodeId: String(e.toNodeId), isLoop: !!e.isLoop })),
    );
    if (errors.length > 0 && srcNodes.length > 0) return c.json({ error: "Invalid workflow graph", errors }, 400);

    const now = new Date().toISOString();
    const id = randomUUID();
    await database.insert(workflowTemplates).values({
      id, projectId, name: tplName, description: tplDesc ?? null, ticketType: tplType,
      isDefault: !!isDefault, isBuiltin: false, builtinKey: null, createdAt: now, updatedAt: now,
    });
    await writeTemplateGraph(database, id, srcNodes, srcEdges);
    boardEvents?.broadcast(projectId, "workflow_template_saved");
    return c.json({ id, ...(await loadGraph(database, id)) }, 201);
  });

  // POST /api/workflows/templates/import — import JSON as a new project template.
  router.post("/templates/import", async (c) => {
    const body = await parseJsonBody(c);
    const projectId = (body as any)?.projectId;
    if (!projectId) return c.json({ error: "projectId is required" }, 400);
    const spec = normalizeImportedTemplate(body);
    const importErrors = validateImportedTemplate(spec);
    if (importErrors.length > 0) {
      return c.json({ error: "Invalid workflow import", errors: importErrors }, 400);
    }

    const result = await createWorkflowTemplate(database, {
      projectId,
      name: spec.name.trim(),
      description: spec.description,
      ticketType: spec.ticketType,
      isDefault: spec.isDefault,
      nodes: spec.nodes,
      edges: spec.edges,
    });
    if (!result.ok) return c.json({ error: "Invalid workflow graph", errors: result.errors }, 400);

    boardEvents?.broadcast(projectId, "workflow_template_saved");
    const rows = await database
      .select()
      .from(workflowTemplates)
      .where(eq(workflowTemplates.id, result.id))
      .limit(1);
    return c.json({ ...rows[0], ...(await loadGraph(database, result.id)) }, 201);
  });

  // PUT /api/workflows/templates/:id — update a non-builtin template's graph in place.
  router.put("/templates/:id", async (c) => {
    const id = c.req.param("id");
    const rows = await database.select().from(workflowTemplates).where(eq(workflowTemplates.id, id)).limit(1);
    if (rows.length === 0) return c.json({ error: "Template not found" }, 404);
    if (rows[0].isBuiltin) {
      return c.json({ error: "Built-in workflows cannot be edited. Duplicate it first (POST with cloneFrom)." }, 400);
    }
    const body = await parseJsonBody(c);
    const { name, description, ticketType, isDefault, nodes = [], edges = [] } = body as any;

    const errors = validateGraph(
      nodes.map((n: any) => ({ id: String(n.id), name: n.name, nodeType: n.nodeType })),
      edges.map((e: any) => ({ fromNodeId: String(e.fromNodeId), toNodeId: String(e.toNodeId), isLoop: !!e.isLoop })),
    );
    if (errors.length > 0) return c.json({ error: "Invalid workflow graph", errors }, 400);

    const now = new Date().toISOString();
    await database.update(workflowTemplates).set({
      name: name ?? rows[0].name,
      description: description ?? rows[0].description,
      ticketType: ticketType !== undefined ? ticketType : rows[0].ticketType,
      isDefault: isDefault !== undefined ? !!isDefault : rows[0].isDefault,
      updatedAt: now,
    }).where(eq(workflowTemplates.id, id));
    await writeTemplateGraph(database, id, nodes, edges);
    if (rows[0].projectId) boardEvents?.broadcast(rows[0].projectId, "workflow_template_saved");
    return c.json({ id, ...(await loadGraph(database, id)) });
  });

  // DELETE /api/workflows/templates/:id — delete a non-builtin template (cascade nodes/edges).
  router.delete("/templates/:id", async (c) => {
    const id = c.req.param("id");
    const rows = await database.select().from(workflowTemplates).where(eq(workflowTemplates.id, id)).limit(1);
    if (rows.length === 0) return c.json({ error: "Template not found" }, 404);
    if (rows[0].isBuiltin) return c.json({ error: "Built-in workflows cannot be deleted." }, 400);
    await database.delete(workflowEdges).where(eq(workflowEdges.templateId, id));
    await database.delete(workflowNodes).where(eq(workflowNodes.templateId, id));
    await database.delete(workflowTemplates).where(eq(workflowTemplates.id, id));
    if (rows[0].projectId) boardEvents?.broadcast(rows[0].projectId, "workflow_template_deleted");
    return c.json({ ok: true });
  });

  // GET /api/workflows/analytics?projectId= — per-node visit counts, avg dwell
  // time, and drop-off (entered but not advanced, excluding end nodes).
  router.get("/analytics", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);

    // All transitions for this project's workspaces, with node metadata.
    const rows = await database
      .select({
        workspaceId: workflowTransitions.workspaceId,
        toNodeId: workflowTransitions.toNodeId,
        createdAt: workflowTransitions.createdAt,
        nodeName: workflowNodes.name,
        nodeType: workflowNodes.nodeType,
        templateId: workflowNodes.templateId,
      })
      .from(workflowTransitions)
      .innerJoin(workspaces, eq(workflowTransitions.workspaceId, workspaces.id))
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .leftJoin(workflowNodes, eq(workflowTransitions.toNodeId, workflowNodes.id))
      .where(eq(issues.projectId, projectId));

    // Group by workspace and order chronologically to compute dwell times.
    const byWorkspace = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!byWorkspace.has(r.workspaceId)) byWorkspace.set(r.workspaceId, [] as any);
      byWorkspace.get(r.workspaceId)!.push(r);
    }

    interface Agg { nodeId: string; nodeName: string; nodeType: string; visits: number; left: number; stuck: number; totalDwellMs: number; dwellSamples: number }
    const agg = new Map<string, Agg>();
    const ensure = (id: string, name: string, type: string): Agg => {
      let a = agg.get(id);
      if (!a) { a = { nodeId: id, nodeName: name, nodeType: type, visits: 0, left: 0, stuck: 0, totalDwellMs: 0, dwellSamples: 0 }; agg.set(id, a); }
      return a;
    };

    for (const seq of byWorkspace.values()) {
      seq.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      for (let i = 0; i < seq.length; i++) {
        const cur = seq[i];
        const a = ensure(cur.toNodeId, cur.nodeName ?? "(deleted)", cur.nodeType ?? "normal");
        a.visits++;
        const next = seq[i + 1];
        if (next) {
          a.left++;
          const dwell = new Date(next.createdAt).getTime() - new Date(cur.createdAt).getTime();
          if (Number.isFinite(dwell) && dwell >= 0) { a.totalDwellMs += dwell; a.dwellSamples++; }
        } else if (cur.nodeType !== "end") {
          a.stuck++; // currently sitting here / dropped off (not a terminal node)
        }
      }
    }

    const nodes = [...agg.values()].map((a) => ({
      nodeId: a.nodeId,
      nodeName: a.nodeName,
      nodeType: a.nodeType,
      visits: a.visits,
      avgDwellMs: a.dwellSamples > 0 ? Math.round(a.totalDwellMs / a.dwellSamples) : null,
      dropoff: a.stuck,
    })).sort((x, y) => y.visits - x.visits);

    return c.json({ totalWorkspaces: byWorkspace.size, nodes });
  });

  // GET /api/workflows/resolve?issueId= — which template an issue uses (for the create picker default).
  router.get("/resolve", async (c) => {
    const issueId = c.req.query("issueId");
    const projectId = c.req.query("projectId");
    const issueType = c.req.query("issueType");
    if (issueId) {
      const rows = await database
        .select({
          projectId: issues.projectId,
          issueType: issues.issueType,
          workflowTemplateId: issues.workflowTemplateId,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .limit(1);
      if (rows.length === 0) return c.json({ error: "Issue not found" }, 404);
      const templateId = await resolveTemplateForIssue(database, {
        projectId: rows[0].projectId,
        issueType: rows[0].issueType,
        explicitTemplateId: rows[0].workflowTemplateId,
      });
      return c.json({ templateId });
    }
    if (projectId) {
      const templateId = await resolveTemplateForIssue(database, {
        projectId,
        issueType: issueType ?? null,
      });
      return c.json({ templateId });
    }
    return c.json({ error: "issueId or projectId required" }, 400);
  });

  // GET /api/workflows/workspaces/:id/progress — current node + transition history + graph.
  router.get("/workspaces/:id/progress", async (c) => {
    const workspaceId = c.req.param("id");
    const wsRows = await database
      .select({
        id: workspaces.id,
        issueId: workspaces.issueId,
        currentNodeId: workspaces.currentNodeId,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (wsRows.length === 0) return c.json({ error: "Workspace not found" }, 404);
    const ws = wsRows[0];

    const issueRows = await database
      .select({ workflowTemplateId: issues.workflowTemplateId })
      .from(issues)
      .where(eq(issues.id, ws.issueId))
      .limit(1);
    const templateId = issueRows[0]?.workflowTemplateId ?? null;

    const transitions = await database
      .select()
      .from(workflowTransitions)
      .where(eq(workflowTransitions.workspaceId, workspaceId))
      .orderBy(asc(workflowTransitions.createdAt));

    const graph = templateId ? await loadGraph(database, templateId) : { nodes: [], edges: [] };
    const currentNode = ws.currentNodeId
      ? graph.nodes.find((n) => n.id === ws.currentNodeId) ?? null
      : null;
    const nextTransitions = ws.currentNodeId
      ? await getOutgoingTransitions(database, ws.currentNodeId)
      : [];

    // Evaluate edge conditions against live workspace signals for UI styling.
    const signals = nextTransitions.length > 0
      ? await computeWorkspaceSignals(database, workspaceId)
      : {};
    const nextWithVerdicts = nextTransitions.map((t) => ({
      ...t,
      verdict: evaluateCondition(t.condition, signals),
    }));

    return c.json({
      workspaceId,
      templateId,
      currentNodeId: ws.currentNodeId,
      currentNode,
      nextTransitions: nextWithVerdicts,
      transitions,
      ...graph,
    });
  });

  // POST /api/workflows/workspaces/:id/transition — manual transition (UI-driven).
  router.post("/workspaces/:id/transition", async (c) => {
    const workspaceId = c.req.param("id");
    const body = await parseJsonBody(c);
    const { toNodeId, toNodeName, summary } = body as {
      toNodeId?: string;
      toNodeName?: string;
      summary?: string;
    };
    if (!toNodeId && !toNodeName) {
      return c.json({ error: "toNodeId or toNodeName is required" }, 400);
    }
    const signals = await computeWorkspaceSignals(database, workspaceId);
    const result = await proposeTransition(database, {
      workspaceId,
      toNodeId,
      toNodeName,
      summary,
      triggeredBy: "manual",
      signals,
    });
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    // Notify the board so the UI reflects the new stage/status.
    const projRows = await database
      .select({ projectId: issues.projectId })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (projRows[0]?.projectId) {
      boardEvents?.broadcast(projRows[0].projectId, "workflow_transition");
    }

    // Run fork/join orchestration (spawn children / consolidate) for this move.
    onWorkflowAdvanced?.(workspaceId);

    return c.json({
      ok: true,
      movedTo: result.toNode?.name,
      nodeType: result.toNode?.nodeType ?? null,
      status: result.statusName,
      nextStages: (result.nextTransitions ?? []).map((t) => t.toNodeName),
      terminal: (result.nextTransitions ?? []).length === 0,
    });
  });

  return router;
}
