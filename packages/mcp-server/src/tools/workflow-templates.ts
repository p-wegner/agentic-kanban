import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";
import {
  listWorkflowTemplates,
  getTemplateGraph,
  createWorkflowTemplate,
  updateWorkflowTemplate,
  deleteWorkflowTemplate,
} from "@agentic-kanban/shared/lib/workflow-engine";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (o: unknown) => text(JSON.stringify(o, null, 2));

async function resolveProjectId(deps: ToolDeps, projectId?: string): Promise<string | null> {
  if (projectId) return projectId;
  const pref = await deps.db
    .select({ value: deps.schema.preferences.value })
    .from(deps.schema.preferences)
    .where(eq(deps.schema.preferences.key, "activeProjectId"))
    .limit(1);
  return pref[0]?.value ?? null;
}

const nodeSchema = z.object({
  id: z.string().describe("Client-side node id, referenced by edges (remapped on save)"),
  name: z.string(),
  nodeType: z.enum(["start", "normal", "parallel-fork", "parallel-join", "end"]).optional(),
  statusName: z.string().nullable().optional().describe("Board status column this stage maps to"),
  skillId: z.string().nullable().optional(),
  skillName: z.string().nullable().optional().describe("Built-in/disk skill name to attach to this stage"),
  maxVisits: z.number().optional().describe("Per-(workspace,node) visit budget; 0 = unlimited"),
  config: z.string().nullable().optional().describe('JSON string, e.g. {"guidance":"..."}'),
  posX: z.number().optional(),
  posY: z.number().optional(),
});
const edgeSchema = z.object({
  fromNodeId: z.string(),
  toNodeId: z.string(),
  label: z.string().nullable().optional(),
  condition: z.enum(["manual", "auto_on_exit_0", "tests_pass", "tests_fail", "diff_clean", "diff_touches"]).optional(),
});

export function registerListWorkflowTemplates(server: McpServer, deps: ToolDeps = prodDeps) {
  server.tool(
    "list_workflow_templates",
    "List workflow templates available to a project (project-scoped + global built-ins). Returns id, name, ticketType, isBuiltin, and stage/edge counts.",
    { projectId: z.string().optional().describe("Project ID (defaults to active project)") },
    async ({ projectId }) => {
      const pid = await resolveProjectId(deps, projectId);
      if (!pid) return text("No active project.");
      const tpls = await listWorkflowTemplates(deps.db, pid);
      const out = await Promise.all(
        tpls.map(async (t) => {
          const g = await getTemplateGraph(deps.db, t.id);
          return { id: t.id, name: t.name, ticketType: t.ticketType, isDefault: t.isDefault, isBuiltin: t.isBuiltin, stages: g?.nodes.length ?? 0, transitions: g?.edges.length ?? 0 };
        }),
      );
      return json(out);
    },
  );
}

export function registerGetWorkflowTemplate(server: McpServer, deps: ToolDeps = prodDeps) {
  server.tool(
    "get_workflow_template",
    "Get a workflow template's full graph (nodes + edges) by id.",
    { templateId: z.string() },
    async ({ templateId }) => {
      const g = await getTemplateGraph(deps.db, templateId);
      if (!g) return text(`Template ${templateId} not found`);
      return json(g);
    },
  );
}

export function registerCreateWorkflowTemplate(server: McpServer, deps: ToolDeps = prodDeps) {
  server.tool(
    "create_workflow_template",
    "Create a project workflow template (graph of stages + transitions). Each node maps to a board status and may attach a skill by name. Exactly one 'start', at least one 'end', no orphan nodes; a 'parallel-fork' needs a matching 'parallel-join'. Edges support conditions (manual/auto_on_exit_0/tests_pass/tests_fail/diff_clean/diff_touches). Use node-type 'parallel-fork' to run branches concurrently (e.g. parallel research) and 'parallel-join' to consolidate.",
    {
      projectId: z.string().optional().describe("Project ID (defaults to active project)"),
      name: z.string(),
      description: z.string().optional(),
      ticketType: z.enum(["task", "bug", "feature", "chore"]).nullable().optional().describe("Make this the default workflow for the given ticket type"),
      isDefault: z.boolean().optional(),
      nodes: z.array(nodeSchema),
      edges: z.array(edgeSchema),
    },
    async ({ projectId, name, description, ticketType, isDefault, nodes, edges }) => {
      const pid = await resolveProjectId(deps, projectId);
      if (!pid) return text("No active project.");
      const res = await createWorkflowTemplate(deps.db, {
        projectId: pid, name, description, ticketType: ticketType ?? null, isDefault, nodes: nodes as any, edges: edges as any,
      });
      if (!res.ok) return json({ error: "Invalid workflow graph", errors: res.errors });
      deps.notifyBoard(pid, "mcp_create_workflow_template");
      return json({ id: res.id, name });
    },
  );
}

export function registerUpdateWorkflowTemplate(server: McpServer, deps: ToolDeps = prodDeps) {
  server.tool(
    "update_workflow_template",
    "Update a non-built-in workflow template. Pass nodes+edges together to replace the graph (validated). Built-in templates cannot be edited — duplicate via create_workflow_template first.",
    {
      templateId: z.string(),
      name: z.string().optional(),
      description: z.string().nullable().optional(),
      ticketType: z.enum(["task", "bug", "feature", "chore"]).nullable().optional(),
      isDefault: z.boolean().optional(),
      nodes: z.array(nodeSchema).optional(),
      edges: z.array(edgeSchema).optional(),
    },
    async ({ templateId, name, description, ticketType, isDefault, nodes, edges }) => {
      const res = await updateWorkflowTemplate(deps.db, templateId, {
        name, description, ticketType, isDefault, nodes: nodes as any, edges: edges as any,
      });
      if (!res.ok) return json({ error: res.error, errors: (res as any).errors });
      const t = await getTemplateGraph(deps.db, templateId);
      if (t?.projectId) deps.notifyBoard(t.projectId, "mcp_update_workflow_template");
      return json({ ok: true, id: templateId });
    },
  );
}

export function registerDeleteWorkflowTemplate(server: McpServer, deps: ToolDeps = prodDeps) {
  server.tool(
    "delete_workflow_template",
    "Delete a non-built-in workflow template (cascades its nodes + edges).",
    { templateId: z.string() },
    async ({ templateId }) => {
      const t = await getTemplateGraph(deps.db, templateId);
      const res = await deleteWorkflowTemplate(deps.db, templateId);
      if (!res.ok) return text(res.error);
      if (t?.projectId) deps.notifyBoard(t.projectId, "mcp_delete_workflow_template");
      return json({ ok: true });
    },
  );
}
