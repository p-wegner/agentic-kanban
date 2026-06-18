import type { Database } from "../db/index.js";
import {
  createWorkflowTemplate,
  proposeTransition,
  resolveTemplateForIssue,
  getOutgoingTransitions,
  getNode,
  countNodeVisits,
  validateGraph,
  writeTemplateGraph,
  computeWorkspaceSignals,
  evaluateCondition,
} from "@agentic-kanban/shared/lib/workflow-engine";
import type { SignalContext } from "@agentic-kanban/shared/lib/workflow-engine";
import {
  loadGraph,
  listTemplateRows,
  getTemplateRow,
  insertTemplate,
  updateTemplateRow,
  deleteTemplateCascade,
  getAnalyticsRows,
  getStageNodeRow,
  getStageVisitRows,
  getIssueResolveRow,
  getWorkspaceProgressRow,
  getIssueTemplateIdRow,
  getWorkspaceTransitions,
  getCurrentNodeRow,
  getWorkspaceProjectRow,
} from "../repositories/workflow.repository.js";
import { randomUUID } from "node:crypto";
import type { BoardEvents } from "./board-events.js";
import { materializeSpecTasksForWorkspace } from "./spec-tasks-materialization.service.js";
import { materializeLatestPhaseArtifactForWorkspace } from "./phase-artifacts.service.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface WorkflowServiceDeps {
  database: Database;
  boardEvents?: BoardEvents;
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

// ── Pure helpers (module-level, no DB dependency) ──────────────────────────

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
  } else {
    spec.nodes.forEach((node, index) => {
      if (!node || typeof node !== "object") {
        errors.push(`Imported workflow node at index ${index} must be an object.`);
        return;
      }
      if (typeof node.id !== "string" || node.id.trim().length === 0) {
        errors.push(`Imported workflow node at index ${index} must have a non-empty string id.`);
      }
      if (typeof node.nodeType !== "string" || node.nodeType.trim().length === 0) {
        errors.push(`Imported workflow node at index ${index} must have a non-empty string nodeType.`);
      }
    });
  }
  if (!Array.isArray(spec.edges)) {
    errors.push("Imported workflow edges must be an array.");
  } else {
    spec.edges.forEach((edge, index) => {
      if (!edge || typeof edge !== "object") {
        errors.push(`Imported workflow edge at index ${index} must be an object.`);
        return;
      }
      if (typeof edge.fromNodeId !== "string" || edge.fromNodeId.trim().length === 0) {
        errors.push(`Imported workflow edge at index ${index} must have a non-empty string fromNodeId.`);
      }
      if (typeof edge.toNodeId !== "string" || edge.toNodeId.trim().length === 0) {
        errors.push(`Imported workflow edge at index ${index} must have a non-empty string toNodeId.`);
      }
    });
  }
  return errors;
}

async function validateTransitionRequest(
  database: Database,
  input: {
    currentNodeId: string | null;
    toNodeId?: string;
    toNodeName?: string;
    signals: SignalContext;
    workspaceId: string;
  },
): Promise<string | null> {
  if (!input.currentNodeId) {
    return "This workspace is not running a workflow (no current node).";
  }

  const transitions = await getOutgoingTransitions(database, input.currentNodeId);
  const target = input.toNodeId
    ? transitions.find((t) => t.toNodeId === input.toNodeId)
    : transitions.find((t) => t.toNodeName === input.toNodeName)
      ?? transitions.find((t) => t.toNodeName.toLowerCase() === input.toNodeName?.toLowerCase());

  if (!target) {
    const valid = transitions.map((t) => t.toNodeName).join(", ") || "(none - terminal stage)";
    return `No valid transition to "${input.toNodeName ?? input.toNodeId}" from the current stage. Valid next stages: ${valid}`;
  }

  const verdict = evaluateCondition(target.condition, input.signals);
  if (verdict === "block") {
    return `Transition to "${target.toNodeName}" is gated by condition "${target.condition}", which is not satisfied by the current workspace state.`;
  }

  const toNode = await getNode(database, target.toNodeId);
  if (!toNode) return `Target node ${target.toNodeId} not found`;
  if (toNode.maxVisits > 0) {
    const visits = await countNodeVisits(database, input.workspaceId, toNode.id);
    if (visits >= toNode.maxVisits) {
      return `Node "${toNode.name}" has reached its visit budget (${toNode.maxVisits}). Escalate to a human instead of looping further.`;
    }
  }

  return null;
}

// ── Service factory ────────────────────────────────────────────────────────

export function createWorkflowService(deps: WorkflowServiceDeps) {
  const { database, boardEvents, onWorkflowAdvanced } = deps;

  // ── Template CRUD ──────────────────────────────────────────────────────

  async function listTemplates(opts: {
    projectId?: string;
    ticketType?: string;
    withGraph?: boolean;
  }) {
    const rows = await listTemplateRows({ projectId: opts.projectId }, database);

    let filtered = rows;
    if (opts.ticketType) {
      filtered = rows.filter((r) => r.ticketType === opts.ticketType || r.ticketType === null);
    }

    if (!opts.withGraph) return filtered;
    return Promise.all(
      filtered.map(async (t) => ({ ...t, ...(await loadGraph(database, t.id)) })),
    );
  }

  async function getTemplate(id: string) {
    const rows = await getTemplateRow(id, database);
    if (rows.length === 0) return { error: "Template not found" as const };
    const graph = await loadGraph(database, id);
    return { data: { ...rows[0], ...graph } };
  }

  async function exportTemplate(id: string) {
    const rows = await getTemplateRow(id, database);
    if (rows.length === 0) return { error: "Template not found" as const };
    const graph = await loadGraph(database, id);
    return { data: toTemplateJson(rows[0], graph) };
  }

  async function createTemplate(opts: {
    projectId: string;
    name?: string;
    description?: string | null;
    ticketType?: string | null;
    isDefault?: boolean;
    nodes?: any[];
    edges?: any[];
    cloneFrom?: string;
  }) {
    if (!opts.projectId) return { error: "projectId is required" as const };

    let srcNodes = opts.nodes ?? [];
    let srcEdges = opts.edges ?? [];
    let tplName = opts.name;
    let tplDesc: string | null | undefined = opts.description;
    let tplType = opts.ticketType ?? null;

    if (opts.cloneFrom) {
      const src = await getTemplateRow(opts.cloneFrom, database);
      if (src.length === 0) return { error: "cloneFrom template not found" as const };
      const g = await loadGraph(database, opts.cloneFrom);
      srcNodes = g.nodes.map((n) => ({ ...n }));
      srcEdges = g.edges.map((e) => ({ ...e }));
      tplName = opts.name ?? `${src[0].name} (copy)`;
      tplDesc = opts.description ?? src[0].description;
      tplType = opts.ticketType ?? null;
    }
    if (!tplName) return { error: "name is required" as const };

    const errors = validateGraph(
      srcNodes.map((n: any) => ({ id: String(n.id), name: n.name, nodeType: n.nodeType })),
      srcEdges.map((e: any) => ({ fromNodeId: String(e.fromNodeId), toNodeId: String(e.toNodeId), isLoop: !!e.isLoop })),
    );
    if (errors.length > 0 && srcNodes.length > 0) {
      return { error: "Invalid workflow graph" as const, errors };
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    await insertTemplate({
      id, projectId: opts.projectId, name: tplName, description: tplDesc ?? null, ticketType: tplType,
      isDefault: !!opts.isDefault, isBuiltin: false, builtinKey: null, createdAt: now, updatedAt: now,
    }, database);
    await writeTemplateGraph(database, id, srcNodes, srcEdges);
    boardEvents?.broadcast(opts.projectId, "workflow_template_saved");
    const rows = await getTemplateRow(id, database);
    return { data: { ...rows[0], ...(await loadGraph(database, id)) } };
  }

  async function importTemplate(opts: { projectId: string; raw: any }) {
    if (!opts.projectId) return { error: "projectId is required" as const };
    const spec = normalizeImportedTemplate(opts.raw);
    const importErrors = validateImportedTemplate(spec);
    if (importErrors.length > 0) {
      return { error: "Invalid workflow import" as const, errors: importErrors };
    }

    const result = await createWorkflowTemplate(database, {
      projectId: opts.projectId,
      name: spec.name.trim(),
      description: spec.description,
      ticketType: spec.ticketType,
      isDefault: spec.isDefault,
      nodes: spec.nodes,
      edges: spec.edges,
    });
    if (!result.ok) return { error: "Invalid workflow graph" as const, errors: result.errors };

    boardEvents?.broadcast(opts.projectId, "workflow_template_saved");
    const rows = await getTemplateRow(result.id, database);
    return { data: { ...rows[0], ...(await loadGraph(database, result.id)) } };
  }

  async function updateTemplate(id: string, opts: {
    name?: string;
    description?: string | null;
    ticketType?: string | null;
    isDefault?: boolean;
    nodes?: any[];
    edges?: any[];
  }) {
    const rows = await getTemplateRow(id, database);
    if (rows.length === 0) return { error: "Template not found" as const };
    if (rows[0].isBuiltin) {
      return { error: "Built-in workflows cannot be edited. Duplicate it first (POST with cloneFrom)." as const };
    }

    const shouldWriteGraph = opts.nodes !== undefined || opts.edges !== undefined;
    const nodes = opts.nodes ?? [];
    const edges = opts.edges ?? [];
    if (shouldWriteGraph) {
      const errors = validateGraph(
        nodes.map((n: any) => ({ id: String(n.id), name: n.name, nodeType: n.nodeType })),
        edges.map((e: any) => ({ fromNodeId: String(e.fromNodeId), toNodeId: String(e.toNodeId), isLoop: !!e.isLoop })),
      );
      if (errors.length > 0) return { error: "Invalid workflow graph" as const, errors };
    }

    const now = new Date().toISOString();
    await updateTemplateRow(id, {
      name: opts.name ?? rows[0].name,
      description: opts.description !== undefined ? opts.description : rows[0].description,
      ticketType: opts.ticketType !== undefined ? opts.ticketType : rows[0].ticketType,
      isDefault: opts.isDefault !== undefined ? !!opts.isDefault : rows[0].isDefault,
      updatedAt: now,
    }, database);
    if (shouldWriteGraph) {
      await writeTemplateGraph(database, id, nodes, edges);
    }
    if (rows[0].projectId) boardEvents?.broadcast(rows[0].projectId, "workflow_template_saved");
    const updatedRows = await getTemplateRow(id, database);
    return { data: { ...updatedRows[0], ...(await loadGraph(database, id)) } };
  }

  async function deleteTemplate(id: string) {
    const rows = await getTemplateRow(id, database);
    if (rows.length === 0) return { error: "Template not found" as const };
    if (rows[0].isBuiltin) return { error: "Built-in workflows cannot be deleted." as const };
    await deleteTemplateCascade(id, database);
    if (rows[0].projectId) boardEvents?.broadcast(rows[0].projectId, "workflow_template_deleted");
    return { ok: true };
  }

  // ── Analytics ──────────────────────────────────────────────────────────

  async function getAnalytics(projectId: string) {
    const rows = await getAnalyticsRows(projectId, database);

    const byWorkspace = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!byWorkspace.has(r.workspaceId)) byWorkspace.set(r.workspaceId, [] as any);
      byWorkspace.get(r.workspaceId)!.push(r);
    }

    interface Agg {
      nodeId: string;
      templateId: string | null;
      templateName: string | null;
      nodeName: string;
      nodeType: string;
      sortOrder: number;
      visits: number;
      left: number;
      stuck: number;
      totalDwellMs: number;
      dwellSamples: number;
    }
    const agg = new Map<string, Agg>();
    const ensure = (
      id: string,
      templateId: string | null,
      templateName: string | null,
      name: string,
      type: string,
      sortOrder: number | null,
    ): Agg => {
      let a = agg.get(id);
      if (!a) {
        a = {
          nodeId: id, templateId, templateName, nodeName: name, nodeType: type,
          sortOrder: sortOrder ?? 0, visits: 0, left: 0, stuck: 0, totalDwellMs: 0, dwellSamples: 0,
        };
        agg.set(id, a);
      }
      return a;
    };
    const dwellBuckets = new Map<string, {
      date: string;
      nodeId: string;
      nodeName: string;
      totalDwellMs: number;
      samples: number;
    }>();
    const startedByDate = new Map<string, number>();
    const completedByDate = new Map<string, number>();
    const dateKey = (value: string) => value.slice(0, 10);
    const addCount = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

    for (const seq of byWorkspace.values()) {
      seq.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      if (seq[0]) addCount(startedByDate, dateKey(seq[0].createdAt));
      for (let i = 0; i < seq.length; i++) {
        const cur = seq[i];
        const nodeType = cur.nodeType ?? "normal";
        const a = ensure(
          cur.toNodeId, cur.templateId ?? null, cur.templateName ?? null,
          cur.nodeName ?? "(deleted)", nodeType, cur.sortOrder,
        );
        a.visits++;
        const next = seq[i + 1];
        if (next) {
          a.left++;
          const dwell = new Date(next.createdAt).getTime() - new Date(cur.createdAt).getTime();
          if (Number.isFinite(dwell) && dwell >= 0) {
            a.totalDwellMs += dwell;
            a.dwellSamples++;
            const bucketKey = `${dateKey(cur.createdAt)}:${cur.toNodeId}`;
            const bucket = dwellBuckets.get(bucketKey) ?? {
              date: dateKey(cur.createdAt), nodeId: cur.toNodeId,
              nodeName: cur.nodeName ?? "(deleted)", totalDwellMs: 0, samples: 0,
            };
            bucket.totalDwellMs += dwell;
            bucket.samples++;
            dwellBuckets.set(bucketKey, bucket);
          }
        } else if (nodeType !== "end") {
          a.stuck++;
        } else {
          addCount(completedByDate, dateKey(cur.createdAt));
        }
      }
    }

    const nodes = [...agg.values()].map((a) => ({
      nodeId: a.nodeId, templateId: a.templateId, templateName: a.templateName,
      nodeName: a.nodeName, nodeType: a.nodeType, sortOrder: a.sortOrder,
      visits: a.visits,
      avgDwellMs: a.dwellSamples > 0 ? Math.round(a.totalDwellMs / a.dwellSamples) : null,
      dropoff: a.stuck,
    })).sort((x, y) => y.visits - x.visits);

    const durationTrends = [...dwellBuckets.values()]
      .map((bucket) => ({
        date: bucket.date, nodeId: bucket.nodeId, nodeName: bucket.nodeName,
        avgDwellMs: Math.round(bucket.totalDwellMs / bucket.samples),
        samples: bucket.samples,
      }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.nodeName.localeCompare(b.nodeName));

    const funnel = [...agg.values()]
      .sort((a, b) => {
        const template = (a.templateName ?? "").localeCompare(b.templateName ?? "");
        if (template !== 0) return template;
        return a.sortOrder - b.sortOrder || a.nodeName.localeCompare(b.nodeName);
      })
      .map((a) => {
        const advanced = a.nodeType === "end" ? a.visits : a.left;
        return {
          nodeId: a.nodeId, templateId: a.templateId, templateName: a.templateName,
          nodeName: a.nodeName, nodeType: a.nodeType, sortOrder: a.sortOrder,
          entered: a.visits, advanced, dropoff: a.stuck,
          conversionRate: a.visits > 0 ? Math.round((advanced / a.visits) * 100) : 0,
        };
      });

    const dates = [...new Set([...startedByDate.keys(), ...completedByDate.keys()])].sort();
    let cumulativeStarted = 0;
    let cumulativeCompleted = 0;
    const burnDown = dates.map((date) => {
      cumulativeStarted += startedByDate.get(date) ?? 0;
      cumulativeCompleted += completedByDate.get(date) ?? 0;
      return {
        date, started: cumulativeStarted, completed: cumulativeCompleted,
        remaining: Math.max(0, cumulativeStarted - cumulativeCompleted),
      };
    });

    return { totalWorkspaces: byWorkspace.size, nodes, durationTrends, funnel, burnDown };
  }

  async function getStageWorkspaceVisits(opts: {
    templateId: string;
    nodeId: string;
    projectId?: string;
  }) {
    const { templateId, nodeId, projectId } = opts;

    const nodeRows = await getStageNodeRow(templateId, nodeId, database);
    if (nodeRows.length === 0) return { error: "Workflow stage not found" as const };

    const rows = await getStageVisitRows(projectId, database);

    const byWorkspace = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!byWorkspace.has(r.workspaceId)) byWorkspace.set(r.workspaceId, [] as any);
      byWorkspace.get(r.workspaceId)!.push(r);
    }

    const visits: Array<{
      workspaceId: string;
      workspaceName: string;
      issueId: string;
      issueNumber: number | null;
      issueTitle: string;
      enteredAt: string;
      dwellMs: number | null;
      isCurrent: boolean;
    }> = [];

    for (const seq of byWorkspace.values()) {
      seq.sort((a, b) => (a.enteredAt < b.enteredAt ? -1 : 1));
      for (let i = 0; i < seq.length; i++) {
        const cur = seq[i];
        if (cur.toNodeId !== nodeId) continue;
        const next = seq[i + 1];
        let dwellMs: number | null = null;
        if (next) {
          const dwell = new Date(next.enteredAt).getTime() - new Date(cur.enteredAt).getTime();
          dwellMs = Number.isFinite(dwell) && dwell >= 0 ? dwell : null;
        }
        visits.push({
          workspaceId: cur.workspaceId, workspaceName: cur.workspaceName,
          issueId: cur.issueId, issueNumber: cur.issueNumber, issueTitle: cur.issueTitle,
          enteredAt: cur.enteredAt, dwellMs,
          isCurrent: cur.currentNodeId === nodeId && !next,
        });
      }
    }

    visits.sort((a, b) => (a.enteredAt > b.enteredAt ? -1 : 1));

    return {
      data: {
        templateId, nodeId,
        nodeName: nodeRows[0].name,
        nodeType: nodeRows[0].nodeType,
        visits,
      },
    };
  }

  // ── Resolve / Progress ─────────────────────────────────────────────────

  async function resolveTemplate(opts: {
    issueId?: string;
    projectId?: string;
    issueType?: string;
  }) {
    if (opts.issueId) {
      const rows = await getIssueResolveRow(opts.issueId, database);
      if (rows.length === 0) return { error: "Issue not found" as const };
      const templateId = await resolveTemplateForIssue(database, {
        projectId: rows[0].projectId,
        issueType: rows[0].issueType,
        explicitTemplateId: rows[0].workflowTemplateId,
      });
      return { data: { templateId } };
    }
    if (opts.projectId) {
      const templateId = await resolveTemplateForIssue(database, {
        projectId: opts.projectId,
        issueType: opts.issueType ?? null,
      });
      return { data: { templateId } };
    }
    return { error: "issueId or projectId required" as const };
  }

  async function getWorkspaceProgress(workspaceId: string) {
    const wsRows = await getWorkspaceProgressRow(workspaceId, database);
    if (wsRows.length === 0) return { error: "Workspace not found" as const };
    const ws = wsRows[0];

    const issueRows = await getIssueTemplateIdRow(ws.issueId, database);
    const templateId = issueRows[0]?.workflowTemplateId ?? null;

    const transitions = await getWorkspaceTransitions(workspaceId, database);

    const graph = templateId ? await loadGraph(database, templateId) : { nodes: [], edges: [] };
    const currentNode = ws.currentNodeId
      ? graph.nodes.find((n) => n.id === ws.currentNodeId) ?? null
      : null;
    const nextTransitions = ws.currentNodeId
      ? await getOutgoingTransitions(database, ws.currentNodeId)
      : [];

    const signals = nextTransitions.length > 0
      ? await computeWorkspaceSignals(database, workspaceId)
      : {};
    const nextWithVerdicts = nextTransitions.map((t) => ({
      ...t,
      verdict: evaluateCondition(t.condition, signals),
    }));

    return {
      data: {
        workspaceId,
        templateId,
        currentNodeId: ws.currentNodeId,
        currentNode,
        nextTransitions: nextWithVerdicts,
        transitions,
        ...graph,
      },
    };
  }

  // ── Transition execution ───────────────────────────────────────────────

  async function executeTransition(workspaceId: string, opts: {
    toNodeId?: string;
    toNodeName?: string;
    summary?: string;
  }) {
    if (!opts.toNodeId && !opts.toNodeName) {
      return { error: "toNodeId or toNodeName is required" };
    }

    const currentRows = await getCurrentNodeRow(workspaceId, database);

    const signals = await computeWorkspaceSignals(database, workspaceId);
    const transitionError = await validateTransitionRequest(database, {
      workspaceId,
      currentNodeId: currentRows[0]?.currentNodeId ?? null,
      toNodeId: opts.toNodeId,
      toNodeName: opts.toNodeName,
      signals,
    });
    if (transitionError) {
      return { error: transitionError };
    }

    const currentNodeName = currentRows[0]?.nodeName ?? null;
    const phaseArtifact = await materializeLatestPhaseArtifactForWorkspace(database, workspaceId, currentNodeName).catch((err) => {
      console.warn("[workflows] failed to write phase artifact file:", err);
      throw err;
    });

    const wasTasksPhase = currentNodeName?.toLowerCase() === "tasks";
    const taskMaterialization = wasTasksPhase
      ? await materializeSpecTasksForWorkspace(workspaceId, database, { boardEvents }).catch((err) => {
          console.warn("[workflows] failed to materialize spec tasks:", err);
          throw err;
        })
      : { created: [], dependencyEdges: 0, skipped: true, reason: "not-tasks-phase" };
    if (wasTasksPhase && taskMaterialization.skipped && taskMaterialization.reason !== "already-materialized") {
      return { error: `Tasks artifact did not create child issues: ${taskMaterialization.reason}` };
    }

    const result = await proposeTransition(database, {
      workspaceId,
      toNodeId: opts.toNodeId,
      toNodeName: opts.toNodeName,
      summary: opts.summary,
      triggeredBy: "manual",
      signals,
    });
    if (!result.ok) {
      return { error: result.error };
    }

    const projRows = await getWorkspaceProjectRow(workspaceId, database);
    if (projRows[0]?.projectId) {
      boardEvents?.broadcast(projRows[0].projectId, "workflow_transition");
    }

    onWorkflowAdvanced?.(workspaceId);

    return {
      data: {
        ok: true,
        movedTo: result.toNode?.name,
        nodeType: result.toNode?.nodeType ?? null,
        status: result.statusName,
        nextStages: (result.nextTransitions ?? []).map((t) => t.toNodeName),
        terminal: (result.nextTransitions ?? []).length === 0,
        taskMaterialization,
        phaseArtifact,
      },
    };
  }

  return {
    listTemplates,
    getTemplate,
    exportTemplate,
    createTemplate,
    importTemplate,
    updateTemplate,
    deleteTemplate,
    getAnalytics,
    getStageWorkspaceVisits,
    resolveTemplate,
    getWorkspaceProgress,
    executeTransition,
  };
}
