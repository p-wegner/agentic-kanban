import { and, eq, asc, sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../schema/index.js";
import { getDiffShortstat, getChangedFileNames } from "./git-service.js";

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

/**
 * Runtime signals about a workspace's state, evaluated against edge conditions
 * for data-driven routing (conditional edges v2 / ticket #85).
 */
export interface SignalContext {
  /** Did the agent's last test run pass? (reported by the agent) */
  testsPassed?: boolean;
  /** Number of changed files in the workspace diff (computed server-side). */
  diffFilesChanged?: number;
  /** Changed file paths in the workspace diff (computed server-side). */
  diffFiles?: string[];
}

/** Split a stored condition like `diff_touches:packages/**` into base + arg. */
export function parseCondition(condition: string): { base: string; arg: string | null } {
  const idx = condition.indexOf(":");
  if (idx === -1) return { base: condition, arg: null };
  return { base: condition.slice(0, idx), arg: condition.slice(idx + 1) };
}

/** Minimal glob → RegExp supporting `**`, `*`, and `?`. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // collapse `**/`
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Evaluate an edge condition against the workspace signals.
 * - "fire"   — the condition is satisfied; the edge auto-fires.
 * - "block"  — the condition is known to be unsatisfied; the edge must not be taken.
 * - "manual" — no automatic signal applies; the agent/human chooses freely.
 */
export type ConditionVerdict = "fire" | "block" | "manual";

export function evaluateCondition(condition: string, ctx: SignalContext): ConditionVerdict {
  const { base, arg } = parseCondition(condition);
  switch (base) {
    case "manual":
      return "manual";
    case "auto_on_exit_0":
      // The agent reaches this point deliberately when the stage succeeded.
      return "fire";
    case "tests_pass":
      if (ctx.testsPassed === undefined) return "manual";
      return ctx.testsPassed ? "fire" : "block";
    case "tests_fail":
      if (ctx.testsPassed === undefined) return "manual";
      return ctx.testsPassed === false ? "fire" : "block";
    case "diff_clean":
      if (ctx.diffFilesChanged === undefined) return "manual";
      return ctx.diffFilesChanged === 0 ? "fire" : "block";
    case "diff_touches": {
      if (!arg || !ctx.diffFiles) return "manual";
      const re = globToRegExp(arg);
      return ctx.diffFiles.some((f) => re.test(f)) ? "fire" : "block";
    }
    default:
      // agent_score / custom_js / unknown — not auto-evaluable in this version.
      return "manual";
  }
}

/**
 * Compute the live workspace signals used to evaluate edge conditions: the diff
 * state (from git) plus any agent-reported values (e.g. testsPassed). Safe to
 * call with no worktree — diff signals are simply left undefined.
 */
export async function computeWorkspaceSignals(
  db: WorkflowDb,
  workspaceId: string,
  reported?: { testsPassed?: boolean },
): Promise<SignalContext> {
  const ctx: SignalContext = { testsPassed: reported?.testsPassed };
  const rows = await db
    .select({ workingDir: schema.workspaces.workingDir, baseBranch: schema.workspaces.baseBranch })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  const ws = rows[0];
  if (ws?.workingDir) {
    const base = ws.baseBranch || "HEAD";
    try {
      const stat = await getDiffShortstat(ws.workingDir, base);
      ctx.diffFilesChanged = stat.filesChanged;
      ctx.diffFiles = await getChangedFileNames(ws.workingDir, base);
    } catch {
      /* leave diff signals undefined → those conditions fall back to manual */
    }
  }
  return ctx;
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
 * How a parallel-join node consolidates its fork children:
 *  - "artifacts" (default): collect each child branch's diff into an artifacts
 *    file and let the join agent merge them by hand.
 *  - "merge": the server auto-merges every child branch back into the parent
 *    branch at the join (ideal for additive, non-conflicting work like each
 *    child writing a different research doc).
 */
export type JoinStrategy = "artifacts" | "merge";

/** Parse the `joinStrategy` out of a (join) node's JSON config. Defaults to "artifacts". */
export function getJoinStrategy(config: string | null): JoinStrategy {
  if (!config) return "artifacts";
  try {
    const parsed = JSON.parse(config) as { joinStrategy?: string };
    return parsed.joinStrategy === "merge" ? "merge" : "artifacts";
  } catch {
    return "artifacts";
  }
}

/**
 * How a parallel-fork node runs its children:
 *  - "worktree" (default): each child gets its own git worktree + branch (forked
 *    from the parent branch HEAD) and they run concurrently; the join consolidates.
 *  - "shared": children run SEQUENTIALLY in the parent's worktree on the parent's
 *    branch — each commits its contribution before the next starts. Suits additive
 *    work (e.g. each stage appends a different research doc) with no merge step.
 *    (Sequential, not parallel: independent agent processes can't share one git
 *    index safely — concurrent commits would collide on .git/index.lock.)
 */
export type ForkMode = "worktree" | "shared";

/** Parse the `forkMode` out of a (fork) node's JSON config. Defaults to "worktree". */
export function getForkMode(config: string | null): ForkMode {
  if (!config) return "worktree";
  try {
    const parsed = JSON.parse(config) as { forkMode?: string };
    return parsed.forkMode === "shared" ? "shared" : "worktree";
  } catch {
    return "worktree";
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

  // A fork node is a control point: the server spawns the parallel branches
  // automatically. The agent that arrives here has nothing further to do.
  if (node.nodeType === "parallel-fork") {
    lines.push(
      "",
      "This is a **parallel fork**. The system will now spawn the parallel branches automatically — you do NOT need to call `propose_transition`. Your work at this stage is complete; stop here.",
    );
    return lines.join("\n");
  }

  if (transitions.length === 0) {
    lines.push("", "This is a terminal stage — there are no further transitions.");
  } else {
    lines.push("", "When this stage's work is complete, advance the workflow by calling the MCP tool:");
    lines.push(`\`propose_transition({ ${wsArg}toNodeName, summary })\``);
    lines.push("", "Valid next stages from here:");
    const hasConditions = transitions.some((t) => t.condition !== "manual");
    for (const t of transitions) {
      const cond = t.condition === "manual" ? "" : ` _(condition: ${t.condition})_`;
      const why = t.label ? ` — ${t.label}` : "";
      lines.push(`- **${t.toNodeName}**${why}${cond}`);
    }
    if (hasConditions) {
      lines.push(
        "",
        "Some edges are condition-gated. If you ran tests, pass `testsPassed: true|false` and you may omit `toNodeName` to let the workflow auto-route (e.g. tests_pass → review, tests_fail → fix). Diff-based conditions (diff_clean, diff_touches) are evaluated automatically from your committed changes.",
      );
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
  /** True when the engine auto-resolved the target from a firing condition. */
  autoResolved?: boolean;
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
    /** Workspace state signals for evaluating data-driven edge conditions (#85). */
    signals?: SignalContext;
  },
): Promise<ProposeResult> {
  const { workspaceId, toNodeId, toNodeName, summary, triggeredBy = "agent", signals = {} } = opts;

  const wsRows = await db
    .select({
      id: schema.workspaces.id,
      issueId: schema.workspaces.issueId,
      currentNodeId: schema.workspaces.currentNodeId,
      parentWorkspaceId: schema.workspaces.parentWorkspaceId,
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
  let autoResolved = false;

  if (toNodeId) {
    target = transitions.find((t) => t.toNodeId === toNodeId);
  } else if (toNodeName) {
    target =
      transitions.find((t) => t.toNodeName === toNodeName) ??
      transitions.find((t) => t.toNodeName.toLowerCase() === toNodeName.toLowerCase());
  } else {
    // No explicit target: auto-resolve from edge conditions (#85). Take the edge
    // iff exactly one fires given the current signals.
    const firing = transitions.filter((t) => evaluateCondition(t.condition, signals) === "fire");
    if (firing.length === 1) {
      target = firing[0];
      autoResolved = true;
    } else {
      const valid = transitions.map((t) => `${t.toNodeName} [${t.condition}]`).join(", ") || "(none — terminal stage)";
      return {
        ok: false,
        error:
          firing.length === 0
            ? `No edge condition fired automatically. Specify a target stage. Valid next stages: ${valid}`
            : `Multiple edges fired (${firing.map((t) => t.toNodeName).join(", ")}). Specify which stage to advance to.`,
      };
    }
  }

  if (!target) {
    const valid = transitions.map((t) => t.toNodeName).join(", ") || "(none — terminal stage)";
    return {
      ok: false,
      error: `No valid transition to "${toNodeName ?? toNodeId}" from the current stage. Valid next stages: ${valid}`,
    };
  }

  // Gate an explicitly-chosen target whose condition is known to be unsatisfied.
  if (!autoResolved) {
    const verdict = evaluateCondition(target.condition, signals);
    if (verdict === "block") {
      return {
        ok: false,
        error: `Transition to "${target.toNodeName}" is gated by condition "${target.condition}", which is not satisfied by the current workspace state.`,
      };
    }
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

  // A fork child shares the parent's issue; its transitions must NOT drive the
  // shared issue's currentNode/status — only the parent path does that.
  const isForkChild = !!ws.parentWorkspaceId;

  let statusId: string | null = null;
  if (issue && !isForkChild && toNode.statusName) {
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

  if (issue && !isForkChild) {
    const issueUpdate: Record<string, unknown> = { currentNodeId: toNode.id, updatedAt: now };
    if (statusId) {
      issueUpdate.statusId = statusId;
      issueUpdate.statusChangedAt = now;
    }
    await db.update(schema.issues).set(issueUpdate).where(eq(schema.issues.id, issue.id));
  }

  const nextTransitions = await getOutgoingTransitions(db, toNode.id);
  return { ok: true, toNode, statusName: toNode.statusName, statusId, nextTransitions, autoResolved };
}

/**
 * Directly place a workspace on a node (NOT validated against edges) and record
 * the transition. Used by the parallel fork/join orchestrator, where movement is
 * structural (fork → child entry, all-children-joined → join) rather than via a
 * single edge. When `syncIssue` is true, the issue's currentNode + derived status
 * are updated too (used for the parent path, never for fork children).
 */
export async function placeWorkspaceOnNode(
  db: WorkflowDb,
  opts: {
    workspaceId: string;
    issueId: string;
    projectId: string;
    fromNodeId: string | null;
    toNode: WorkflowNodeRow;
    summary?: string;
    triggeredBy?: string;
    syncIssue: boolean;
  },
): Promise<void> {
  const { workspaceId, issueId, projectId, fromNodeId, toNode, summary, triggeredBy = "system", syncIssue } = opts;
  const now = new Date().toISOString();

  await db.insert(schema.workflowTransitions).values({
    id: crypto.randomUUID(),
    workspaceId,
    fromNodeId,
    toNodeId: toNode.id,
    summary: summary ?? null,
    triggeredBy,
    createdAt: now,
  });

  await db
    .update(schema.workspaces)
    .set({ currentNodeId: toNode.id, updatedAt: now })
    .where(eq(schema.workspaces.id, workspaceId));

  if (syncIssue) {
    const issueUpdate: Record<string, unknown> = { currentNodeId: toNode.id, updatedAt: now };
    if (toNode.statusName) {
      const statusId = await resolveStatusId(db, projectId, toNode.statusName);
      if (statusId) {
        issueUpdate.statusId = statusId;
        issueUpdate.statusChangedAt = now;
      }
    }
    await db.update(schema.issues).set(issueUpdate).where(eq(schema.issues.id, issueId));
  }
}

/**
 * Keep currentNodeId consistent when an issue's status is changed manually
 * (drag-drop, move_issue, CLI). If the issue runs a workflow, point currentNodeId
 * at a node in its template whose statusName matches the issue's (new) status.
 * No-op when the issue has no workflow or no node maps to the status.
 */
export async function syncCurrentNodeToStatus(db: WorkflowDb, issueId: string): Promise<void> {
  const issueRows = await db
    .select({ workflowTemplateId: schema.issues.workflowTemplateId, statusId: schema.issues.statusId, currentNodeId: schema.issues.currentNodeId })
    .from(schema.issues)
    .where(eq(schema.issues.id, issueId))
    .limit(1);
  const issue = issueRows[0];
  if (!issue?.workflowTemplateId || !issue.statusId) return;

  const statusRows = await db
    .select({ name: schema.projectStatuses.name })
    .from(schema.projectStatuses)
    .where(eq(schema.projectStatuses.id, issue.statusId))
    .limit(1);
  const statusName = statusRows[0]?.name;
  if (!statusName) return;

  const nodes = await db
    .select()
    .from(schema.workflowNodes)
    .where(eq(schema.workflowNodes.templateId, issue.workflowTemplateId))
    .orderBy(asc(schema.workflowNodes.sortOrder));
  // If the current node already maps to this status, leave it; else pick the first match.
  const current = nodes.find((n) => n.id === issue.currentNodeId);
  if (current && current.statusName === statusName) return;
  const match = nodes.find((n) => n.statusName === statusName);
  if (match) {
    await db.update(schema.issues).set({ currentNodeId: match.id }).where(eq(schema.issues.id, issueId));
  }
}

export interface GraphNodeInput {
  id: string;
  nodeType: string;
}
export interface GraphEdgeInput {
  fromNodeId: string;
  toNodeId: string;
}

/**
 * Validate a workflow graph for the builder (#83). Returns a list of human-
 * readable error strings; empty = valid.
 * Rules: exactly one start; ≥1 end; no orphan nodes (non-start needs an inbound
 * edge, non-end needs an outbound edge); edges reference real nodes; every
 * parallel-join has at least one parallel-fork in the graph.
 */
export function validateGraph(nodes: GraphNodeInput[], edges: GraphEdgeInput[]): string[] {
  const errors: string[] = [];
  if (nodes.length === 0) return ["A workflow needs at least one node."];

  const ids = new Set(nodes.map((n) => n.id));
  const starts = nodes.filter((n) => n.nodeType === "start");
  const ends = nodes.filter((n) => n.nodeType === "end");
  if (starts.length !== 1) errors.push(`A workflow must have exactly one start node (found ${starts.length}).`);
  if (ends.length < 1) errors.push("A workflow must have at least one end node.");

  for (const e of edges) {
    if (!ids.has(e.fromNodeId) || !ids.has(e.toNodeId)) {
      errors.push("An edge references a node that no longer exists.");
      break;
    }
  }

  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const e of edges) {
    outgoing.set(e.fromNodeId, (outgoing.get(e.fromNodeId) ?? 0) + 1);
    incoming.set(e.toNodeId, (incoming.get(e.toNodeId) ?? 0) + 1);
  }
  for (const n of nodes) {
    if (n.nodeType !== "start" && (incoming.get(n.id) ?? 0) === 0) {
      errors.push("Every non-start node must have at least one incoming edge (no orphans).");
      break;
    }
  }
  for (const n of nodes) {
    if (n.nodeType !== "end" && (outgoing.get(n.id) ?? 0) === 0) {
      errors.push("Every non-end node must have at least one outgoing edge.");
      break;
    }
  }

  const hasFork = nodes.some((n) => n.nodeType === "parallel-fork");
  const hasJoin = nodes.some((n) => n.nodeType === "parallel-join");
  if (hasJoin && !hasFork) errors.push("A parallel-join node requires a matching parallel-fork upstream.");
  if (hasFork && !hasJoin) errors.push("A parallel-fork node requires a matching parallel-join downstream.");

  return errors;
}

// ---------------------------------------------------------------------------
// Workflow template CRUD (shared by REST, MCP, and CLI so there is one source
// of truth for validation + node-id remapping).
// ---------------------------------------------------------------------------

export interface TemplateNodeInput {
  id: string; // client-side id, remapped on persist
  name: string;
  nodeType?: string;
  statusName?: string | null;
  skillId?: string | null;
  skillName?: string | null;
  maxVisits?: number;
  config?: string | null;
  posX?: number;
  posY?: number;
  sortOrder?: number;
}
export interface TemplateEdgeInput {
  fromNodeId: string;
  toNodeId: string;
  label?: string | null;
  condition?: string;
  sortOrder?: number;
}
export interface TemplateInput {
  projectId: string;
  name: string;
  description?: string | null;
  ticketType?: string | null;
  isDefault?: boolean;
  nodes: TemplateNodeInput[];
  edges: TemplateEdgeInput[];
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
      sortOrder: e.sortOrder ?? esort++,
      createdAt: now,
    });
  }
}

/** Validate a TemplateInput's graph; returns error strings (empty = valid). */
export function validateTemplateInput(input: { nodes: TemplateNodeInput[]; edges: TemplateEdgeInput[] }): string[] {
  return validateGraph(
    input.nodes.map((n) => ({ id: String(n.id), nodeType: n.nodeType ?? "normal" })),
    input.edges.map((e) => ({ fromNodeId: String(e.fromNodeId), toNodeId: String(e.toNodeId) })),
  );
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

/** Find the (first) parallel-join node in a template, if any. */
export async function findJoinNode(
  db: WorkflowDb,
  templateId: string,
): Promise<WorkflowNodeRow | null> {
  const nodes = await db
    .select()
    .from(schema.workflowNodes)
    .where(eq(schema.workflowNodes.templateId, templateId))
    .orderBy(asc(schema.workflowNodes.sortOrder));
  return (nodes.find((n) => n.nodeType === "parallel-join") as WorkflowNodeRow) ?? null;
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

// ---------------------------------------------------------------------------
// Status derivation helpers (ticket #78 – status-as-view)
// ---------------------------------------------------------------------------

/**
 * Derive the default board status name from a workflow node's structural type.
 * Nodes with an explicit `statusName` always take precedence over this default;
 * this function is the fallback when statusName is null/undefined.
 *
 * - start  → "Backlog"  (issue not yet picked up)
 * - end    → "Done"     (workflow complete)
 * - normal / parallel-fork / parallel-join → "In Progress" (work in flight)
 */
export function deriveStatusName(nodeType: string): string {
  switch (nodeType) {
    case "start":
      return "Backlog";
    case "end":
      return "Done";
    default:
      return "In Progress";
  }
}

/**
 * Returns true when the node type indicates a terminal (done/closed) state.
 * Accepts null/undefined for convenience (non-workflow issues → false).
 */
export function isTerminalNodeType(nodeType: string | null | undefined): boolean {
  return nodeType === "end";
}
