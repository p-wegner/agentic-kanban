import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { projects } from "./projects.js";
import { agentSkills } from "./agent-skills.js";

/**
 * Node types in a workflow graph.
 * - start: entry node (exactly one per template); a new workspace begins here.
 * - normal: a regular stage with an attached skill.
 * - parallel-fork: spawns N parallel branches (sub-worktrees) — runtime fan-out (future).
 * - parallel-join: blocks until forked branches complete, then consolidates artifacts.
 * - end: terminal node; reaching it marks the issue done.
 */
export const WORKFLOW_NODE_TYPES = [
  "start",
  "normal",
  "parallel-fork",
  "parallel-join",
  "end",
] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

/**
 * Edge conditions. v1 supports manual + auto-on-exit-0; the rest are reserved
 * for conditional-edges v2 (evaluated at transition time).
 */
export const WORKFLOW_EDGE_CONDITIONS = [
  "manual",
  "auto_on_exit_0",
  "tests_pass",
  "tests_fail",
  "diff_clean",
] as const;
export type WorkflowEdgeCondition = (typeof WORKFLOW_EDGE_CONDITIONS)[number];

/**
 * A workflow template: a graph of nodes + edges describing the stages an issue
 * of a given ticket type flows through. The legacy four-status board is the
 * "Simple Ticket" template — one special case of this general system.
 */
export const workflowTemplates = sqliteTable(
  "workflow_templates",
  {
    id: text("id").primaryKey(),
    // null projectId = built-in / global template available to every project.
    projectId: text("project_id").references(() => projects.id),
    name: text("name").notNull(),
    description: text("description"),
    // The issue type this template is the default for (task/bug/feature/chore/research/migration).
    // null = not auto-routed; selectable manually.
    ticketType: text("ticket_type"),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
    // Stable key for built-in templates so seeding is idempotent (e.g. "simple-ticket").
    builtinKey: text("builtin_key"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    projectIdIdx: index("idx_workflow_templates_project_id").on(table.projectId),
    ticketTypeIdx: index("idx_workflow_templates_ticket_type").on(table.ticketType),
  }),
);

/** A node = a stage in the graph, with an attached skill. */
export const workflowNodes = sqliteTable(
  "workflow_nodes",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id")
      .notNull()
      .references(() => workflowTemplates.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    nodeType: text("node_type").notNull().default("normal"),
    // Board column this node maps to. The issue's status is derived from the
    // current node's statusName, keeping the existing kanban board intact.
    statusName: text("status_name"),
    // Attached skill: DB skill id takes precedence; skillName is a disk-skill fallback.
    skillId: text("skill_id").references(() => agentSkills.id),
    skillName: text("skill_name"),
    // Per-(workspace,node) visit budget for cycle protection. 0 = unlimited.
    maxVisits: integer("max_visits").notNull().default(0),
    // Free-form node-level config (JSON string).
    config: text("config"),
    // Canvas position for the visual builder.
    posX: integer("pos_x").notNull().default(0),
    posY: integer("pos_y").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    templateIdIdx: index("idx_workflow_nodes_template_id").on(table.templateId),
  }),
);

/** A directed transition between two nodes, with an optional condition. */
export const workflowEdges = sqliteTable(
  "workflow_edges",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id")
      .notNull()
      .references(() => workflowTemplates.id, { onDelete: "cascade" }),
    fromNodeId: text("from_node_id")
      .notNull()
      .references(() => workflowNodes.id, { onDelete: "cascade" }),
    toNodeId: text("to_node_id")
      .notNull()
      .references(() => workflowNodes.id, { onDelete: "cascade" }),
    label: text("label"),
    condition: text("condition").notNull().default("manual"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    templateIdIdx: index("idx_workflow_edges_template_id").on(table.templateId),
    fromNodeIdIdx: index("idx_workflow_edges_from_node_id").on(table.fromNodeId),
  }),
);

/**
 * History of node transitions per workspace. Powers:
 * - maxVisits cycle protection (count rows where toNodeId = N),
 * - the per-workspace progress viewer,
 * - per-node duration / drop-off analytics.
 */
export const workflowTransitions = sqliteTable(
  "workflow_transitions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    fromNodeId: text("from_node_id"),
    toNodeId: text("to_node_id").notNull(),
    summary: text("summary"),
    // Who/what drove the transition: "agent" | "auto" | "manual" | "system".
    triggeredBy: text("triggered_by").notNull().default("agent"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    workspaceIdIdx: index("idx_workflow_transitions_workspace_id").on(table.workspaceId),
    toNodeIdIdx: index("idx_workflow_transitions_to_node_id").on(table.toNodeId),
  }),
);

export const workflowTemplatesRelations = relations(workflowTemplates, ({ one, many }) => ({
  project: one(projects, {
    fields: [workflowTemplates.projectId],
    references: [projects.id],
  }),
  nodes: many(workflowNodes),
  edges: many(workflowEdges),
}));

export const workflowNodesRelations = relations(workflowNodes, ({ one }) => ({
  template: one(workflowTemplates, {
    fields: [workflowNodes.templateId],
    references: [workflowTemplates.id],
  }),
  skill: one(agentSkills, {
    fields: [workflowNodes.skillId],
    references: [agentSkills.id],
  }),
}));

export const workflowEdgesRelations = relations(workflowEdges, ({ one }) => ({
  template: one(workflowTemplates, {
    fields: [workflowEdges.templateId],
    references: [workflowTemplates.id],
  }),
  fromNode: one(workflowNodes, {
    fields: [workflowEdges.fromNodeId],
    references: [workflowNodes.id],
  }),
  toNode: one(workflowNodes, {
    fields: [workflowEdges.toNodeId],
    references: [workflowNodes.id],
  }),
}));

export const workflowTransitionsRelations = relations(workflowTransitions, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workflowTransitions.workspaceId],
    references: [workspaces.id],
  }),
}));

import { workspaces } from "./workspaces.js";
