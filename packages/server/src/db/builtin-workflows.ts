import { db } from "./index.js";
import type { Database } from "./index.js";
import {
  workflowTemplates,
  workflowNodes,
  workflowEdges,
  agentSkills,
} from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { WorkflowNodeType, WorkflowEdgeCondition } from "@agentic-kanban/shared/schema";

/**
 * Built-in workflow template definitions. These are the general-system version
 * of the kanban flow: each ticket type can route through a different graph of
 * stages, every stage maps to a board status column and (optionally) a skill.
 *
 * The legacy `Todo → In Progress → In Review → Done` lane is the "Simple Ticket"
 * template — the default for any issue type without a more specific template.
 *
 * Nodes reference skills by NAME (resolved to a skill id at seed time, falling
 * back to disk skills at runtime), so re-seeding skills never leaves stale ids.
 */

export interface BuiltinNodeDef {
  /** Stable key, unique within the template; referenced by edges. */
  key: string;
  name: string;
  nodeType: WorkflowNodeType;
  /** Board column this node maps to (must be one of the project's statuses). */
  statusName: string;
  /** Built-in skill name to attach, if any. */
  skillName?: string;
  /** Per-(workspace,node) visit budget; 0 = unlimited. */
  maxVisits?: number;
  /** Guidance injected into the agent prompt when it enters this node. */
  guidance?: string;
}

export interface BuiltinEdgeDef {
  from: string;
  to: string;
  label?: string;
  condition?: WorkflowEdgeCondition;
}

export interface BuiltinTemplateDef {
  /** Stable key for idempotent seeding. */
  builtinKey: string;
  name: string;
  description: string;
  /** Issue type this template is the default for (null = manual-select only). */
  ticketType: string | null;
  /** Default for its ticket type within a project. */
  isDefault: boolean;
  nodes: BuiltinNodeDef[];
  edges: BuiltinEdgeDef[];
}

export const BUILTIN_WORKFLOWS: BuiltinTemplateDef[] = [
  {
    builtinKey: "simple-ticket",
    name: "Simple Ticket",
    description:
      "The classic flow: implement → review → done. Default for any issue type without a more specific workflow.",
    ticketType: null,
    isDefault: true,
    nodes: [
      {
        key: "implement",
        name: "Implement",
        nodeType: "start",
        statusName: "In Progress",
        guidance: "Implement the change described in the ticket, then commit. When done, propose a transition to Review.",
      },
      {
        key: "review",
        name: "Review",
        nodeType: "normal",
        statusName: "In Review",
        skillName: "code-review",
        guidance: "Review the committed changes. If they are correct, propose a transition to Done.",
      },
      { key: "done", name: "Done", nodeType: "end", statusName: "Done" },
    ],
    edges: [
      { from: "implement", to: "review", condition: "auto_on_exit_0", label: "changes committed" },
      { from: "review", to: "done", condition: "manual", label: "approved" },
      { from: "review", to: "implement", condition: "manual", label: "changes requested" },
    ],
  },
  {
    builtinKey: "simple-bug",
    name: "Simple Bug",
    description: "Reproduce and fix a straightforward bug, then review.",
    ticketType: "bug",
    isDefault: true,
    nodes: [
      {
        key: "fix",
        name: "Reproduce & Fix",
        nodeType: "start",
        statusName: "In Progress",
        guidance:
          "Reproduce the bug first (write a failing test if practical), then fix it and confirm the test passes. Commit, then propose a transition to Review.",
      },
      {
        key: "review",
        name: "Review",
        nodeType: "normal",
        statusName: "In Review",
        skillName: "code-review",
        guidance: "Review the fix and confirm the regression test covers it. Propose a transition to Done when satisfied.",
      },
      { key: "done", name: "Done", nodeType: "end", statusName: "Done" },
    ],
    edges: [
      { from: "fix", to: "review", condition: "auto_on_exit_0", label: "fix committed" },
      { from: "review", to: "done", condition: "manual", label: "approved" },
      { from: "review", to: "fix", condition: "manual", label: "needs more work" },
    ],
  },
  {
    builtinKey: "hard-bug",
    name: "Hard Bug",
    description: "Research → reproduce → fix → thorough review for tricky bugs that need investigation first.",
    ticketType: null,
    isDefault: false,
    nodes: [
      {
        key: "research",
        name: "Research",
        nodeType: "start",
        statusName: "In Progress",
        guidance:
          "Investigate the bug: read the relevant code, gather logs, and form a hypothesis about the root cause. Document your findings in the issue, then propose a transition to Reproduce.",
      },
      {
        key: "reproduce",
        name: "Reproduce",
        nodeType: "normal",
        statusName: "In Progress",
        guidance: "Write a minimal reproduction (ideally a failing automated test). Propose a transition to Fix once it reliably reproduces.",
      },
      {
        key: "fix",
        name: "Fix",
        nodeType: "normal",
        statusName: "In Progress",
        maxVisits: 5,
        guidance: "Implement the fix, confirm the reproduction now passes, and commit. Propose a transition to Review.",
      },
      {
        key: "review",
        name: "Thorough Review",
        nodeType: "normal",
        statusName: "In Review",
        skillName: "code-review-thorough",
        guidance: "Perform an in-depth review covering correctness, edge cases, and regressions. Propose Done when satisfied, or send back to Fix.",
      },
      { key: "done", name: "Done", nodeType: "end", statusName: "Done" },
    ],
    edges: [
      { from: "research", to: "reproduce", condition: "manual", label: "root cause found" },
      { from: "reproduce", to: "fix", condition: "manual", label: "reproduced" },
      { from: "fix", to: "review", condition: "auto_on_exit_0", label: "fix committed" },
      { from: "review", to: "fix", condition: "manual", label: "needs rework" },
      { from: "review", to: "done", condition: "manual", label: "approved" },
    ],
  },
  {
    builtinKey: "research-task",
    name: "Research Task",
    description: "Deep research → consult the user → write-up. No code changes expected.",
    ticketType: null,
    isDefault: false,
    nodes: [
      {
        key: "research",
        name: "Deep Research",
        nodeType: "start",
        statusName: "In Progress",
        guidance:
          "Investigate the question thoroughly: read code, docs, and external sources. Collect findings and open questions, then propose a transition to Consult User.",
      },
      {
        key: "consult",
        name: "Consult User",
        nodeType: "normal",
        statusName: "In Review",
        guidance: "Surface your findings and any decisions that need human input. Wait for direction, then propose a transition to Write-up.",
      },
      {
        key: "writeup",
        name: "Write-up",
        nodeType: "end",
        statusName: "Done",
        guidance: "Produce the final write-up in the issue description and mark the task complete.",
      },
    ],
    edges: [
      { from: "research", to: "consult", condition: "manual", label: "findings ready" },
      { from: "consult", to: "writeup", condition: "manual", label: "direction received" },
      { from: "consult", to: "research", condition: "manual", label: "needs more research" },
    ],
  },
  {
    builtinKey: "parallel-review",
    name: "Parallel Review",
    description:
      "Implement, then two reviewers (correctness + security) examine the change in parallel sub-worktrees; consolidate their findings at the join, then done. Demonstrates fork/join.",
    ticketType: null,
    isDefault: false,
    nodes: [
      {
        key: "implement",
        name: "Implement",
        nodeType: "start",
        statusName: "In Progress",
        guidance: "Implement the change described in the ticket and commit. Then advance to Split Reviews.",
      },
      {
        key: "fork",
        name: "Split Reviews",
        nodeType: "parallel-fork",
        statusName: "In Review",
        guidance: "Fork point: two reviewers run concurrently in their own sub-worktrees.",
      },
      {
        key: "reviewA",
        name: "Correctness Review",
        nodeType: "normal",
        statusName: "In Review",
        skillName: "code-review",
        guidance: "Review the change for correctness bugs and edge cases. Note findings in a file or commit, then advance to Consolidate.",
      },
      {
        key: "reviewB",
        name: "Security Review",
        nodeType: "normal",
        statusName: "In Review",
        skillName: "code-review-thorough",
        guidance: "Review the change for security and architecture concerns. Note findings, then advance to Consolidate.",
      },
      {
        key: "join",
        name: "Consolidate",
        nodeType: "parallel-join",
        statusName: "In Review",
        skillName: "code-review",
        guidance: "Read WORKFLOW_FORK_ARTIFACTS.md, merge both reviewers' findings into the change on this branch, then advance to Done.",
      },
      { key: "done", name: "Done", nodeType: "end", statusName: "Done" },
    ],
    edges: [
      { from: "implement", to: "fork", condition: "auto_on_exit_0", label: "committed" },
      { from: "fork", to: "reviewA", condition: "manual", label: "correctness" },
      { from: "fork", to: "reviewB", condition: "manual", label: "security" },
      { from: "reviewA", to: "join", condition: "manual", label: "reviewed" },
      { from: "reviewB", to: "join", condition: "manual", label: "reviewed" },
      { from: "join", to: "done", condition: "manual", label: "consolidated" },
    ],
  },
  {
    builtinKey: "migration-with-ai",
    name: "Migration with AI",
    description:
      "Explore legacy → extract requirements → build a safety net (API-agnostic E2E + mocks) → identify modules → migrate test-driven (loop) → consolidate → done.",
    ticketType: null,
    isDefault: false,
    nodes: [
      {
        key: "explore",
        name: "Explore Legacy",
        nodeType: "start",
        statusName: "In Progress",
        guidance: "Map the legacy system: entry points, data flows, and the behavior that must be preserved.",
      },
      {
        key: "requirements",
        name: "Extract Requirements",
        nodeType: "normal",
        statusName: "In Progress",
        guidance: "Distill the observable behavior into explicit, testable requirements.",
      },
      {
        key: "safety-net",
        name: "Safety Net (E2E + mocks)",
        nodeType: "normal",
        statusName: "In Progress",
        guidance:
          "Write API-agnostic end-to-end tests plus mocks that pin the current behavior. These are the safety net the migration must keep green.",
      },
      {
        key: "modules",
        name: "Identify Modules",
        nodeType: "normal",
        statusName: "In Progress",
        guidance: "Break the migration into independently migratable modules and order them by risk.",
      },
      {
        key: "migrate",
        name: "Migrate (test-driven)",
        nodeType: "normal",
        statusName: "In Progress",
        maxVisits: 10,
        guidance:
          "Migrate one module at a time, keeping the safety-net tests green after each. Loop back here for the next module until all are migrated, then propose Consolidate.",
      },
      {
        key: "consolidate",
        name: "Consolidate",
        nodeType: "normal",
        statusName: "In Review",
        skillName: "code-review",
        guidance: "Review the full migration, remove legacy scaffolding, and confirm all safety-net tests pass. Propose Done when clean.",
      },
      { key: "done", name: "Done", nodeType: "end", statusName: "Done" },
    ],
    edges: [
      { from: "explore", to: "requirements", condition: "manual", label: "explored" },
      { from: "requirements", to: "safety-net", condition: "manual", label: "requirements ready" },
      { from: "safety-net", to: "modules", condition: "manual", label: "safety net green" },
      { from: "modules", to: "migrate", condition: "manual", label: "modules identified" },
      { from: "migrate", to: "migrate", condition: "manual", label: "next module" },
      { from: "migrate", to: "consolidate", condition: "manual", label: "all migrated" },
      { from: "consolidate", to: "migrate", condition: "manual", label: "issues found" },
      { from: "consolidate", to: "done", condition: "manual", label: "approved" },
    ],
  },
];

/**
 * Upsert all built-in workflow templates (global, projectId = null) by builtinKey.
 * Idempotent; called from seed() and on server startup.
 */
export async function ensureBuiltinWorkflows(database: Database = db): Promise<void> {
  const now = new Date().toISOString();

  // Resolve global built-in skills by name → id for skill attachment.
  const skills = await database
    .select({ id: agentSkills.id, name: agentSkills.name })
    .from(agentSkills);
  const skillIdByName = new Map(skills.map((s) => [s.name, s.id]));

  const existing = await database
    .select({ builtinKey: workflowTemplates.builtinKey })
    .from(workflowTemplates)
    .where(eq(workflowTemplates.isBuiltin, true));
  const existingKeys = new Set(existing.map((r) => r.builtinKey).filter(Boolean) as string[]);

  let added = 0;
  for (const tpl of BUILTIN_WORKFLOWS) {
    if (existingKeys.has(tpl.builtinKey)) continue;

    const templateId = randomUUID();
    await database.insert(workflowTemplates).values({
      id: templateId,
      projectId: null,
      name: tpl.name,
      description: tpl.description,
      ticketType: tpl.ticketType,
      isDefault: tpl.isDefault,
      isBuiltin: true,
      builtinKey: tpl.builtinKey,
      createdAt: now,
      updatedAt: now,
    });

    const nodeIdByKey = new Map<string, string>();
    let sort = 0;
    for (const node of tpl.nodes) {
      const nodeId = randomUUID();
      nodeIdByKey.set(node.key, nodeId);
      await database.insert(workflowNodes).values({
        id: nodeId,
        templateId,
        name: node.name,
        nodeType: node.nodeType,
        statusName: node.statusName,
        skillId: node.skillName ? skillIdByName.get(node.skillName) ?? null : null,
        skillName: node.skillName ?? null,
        maxVisits: node.maxVisits ?? 0,
        config: node.guidance ? JSON.stringify({ guidance: node.guidance }) : null,
        posX: 0,
        posY: sort * 120,
        sortOrder: sort,
        createdAt: now,
      });
      sort++;
    }

    let edgeSort = 0;
    for (const edge of tpl.edges) {
      const fromId = nodeIdByKey.get(edge.from);
      const toId = nodeIdByKey.get(edge.to);
      if (!fromId || !toId) continue;
      await database.insert(workflowEdges).values({
        id: randomUUID(),
        templateId,
        fromNodeId: fromId,
        toNodeId: toId,
        label: edge.label ?? null,
        condition: edge.condition ?? "manual",
        sortOrder: edgeSort,
        createdAt: now,
      });
      edgeSort++;
    }
    added++;
  }

  if (added > 0) {
    console.log(`Seeded ${added} built-in workflow template(s).`);
  }
}
