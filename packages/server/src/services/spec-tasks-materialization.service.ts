import { randomUUID } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { issueArtifacts, issueDependencies, issues, projectStatuses, workspaces, workflowNodes } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";

interface ParsedTask {
  tempId: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  wave: number;
  explicitDependsOn: string[];
}

interface MaterializeResult {
  created: Array<{ id: string; issueNumber: number; title: string; tempId: string }>;
  dependencyEdges: number;
  skipped: boolean;
  reason?: string;
}

const TASK_LINE = /^\s*(?:[-*]|\d+[.)])\s+\[(?: |x|X)\]\s+(.+)$/;
const WAVE_HEADING = /^\s*#{1,6}\s+(?:wave|phase)\s+(\d+)\b/i;
const INLINE_WAVE = /\b(?:wave|phase)\s+(\d+)\b/i;
const TASK_ID = /\b([A-Z][A-Z0-9_-]*\d+[A-Z0-9_-]*)\b/;
const PRIORITY = /\bpriority\s*:\s*(low|medium|high|critical)\b/i;
const DEPENDS_ON = /\bdepends(?:_on|\s+on)?\s*:\s*([A-Z0-9_,\s-]+)/i;

function cleanTitle(raw: string): { tempId: string | null; title: string; explicitDependsOn: string[]; priority: ParsedTask["priority"] } {
  let text = raw.trim();
  text = text.replace(/^\[P\]\s*/i, "");
  text = text.replace(/\s+\[P\]\s*/gi, " ");

  const explicitDependsOn = DEPENDS_ON.exec(text)?.[1]
    ?.split(/[,\s]+/)
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean) ?? [];
  text = text.replace(DEPENDS_ON, "").trim();

  const priority = (PRIORITY.exec(text)?.[1]?.toLowerCase() ?? "medium") as ParsedTask["priority"];
  text = text.replace(PRIORITY, "").trim();

  const idMatch = TASK_ID.exec(text);
  const tempId = idMatch?.[1]?.toUpperCase() ?? null;
  if (tempId) {
    text = text.replace(new RegExp(`^${tempId}\\b[:.)-]?\\s*`, "i"), "").trim();
  }
  text = text.replace(/\s+[.;,-]\s*$/, "").trim();
  return { tempId, title: text || raw.trim(), explicitDependsOn, priority };
}

export function parseTasksArtifact(markdown: string): ParsedTask[] {
  const lines = markdown.split(/\r?\n/);
  const tasks: ParsedTask[] = [];
  let currentWave = 1;

  for (const line of lines) {
    const waveMatch = WAVE_HEADING.exec(line);
    if (waveMatch) {
      currentWave = Number(waveMatch[1]);
      continue;
    }

    const taskMatch = TASK_LINE.exec(line);
    if (!taskMatch) continue;

    const rawTask = taskMatch[1].trim();
    const inlineWave = INLINE_WAVE.exec(rawTask);
    const wave = inlineWave ? Number(inlineWave[1]) : currentWave;
    const { tempId, title, explicitDependsOn, priority } = cleanTitle(rawTask);
    const fallbackId = `T${String(tasks.length + 1).padStart(3, "0")}`;
    tasks.push({
      tempId: tempId ?? fallbackId,
      title,
      description: `Task from approved spec-driven tasks artifact:\n\n${line.trim()}`,
      priority,
      wave,
      explicitDependsOn,
    });
  }

  return tasks;
}

function buildDependencyEdges(tasks: ParsedTask[], created: Array<{ id: string; tempId: string }>) {
  const byTempId = new Map(created.map((c) => [c.tempId.toUpperCase(), c.id]));
  const byWave = new Map<number, string[]>();
  const edges: Array<{ issueId: string; dependsOnId: string; type: "depends_on" }> = [];

  for (const task of tasks) {
    const id = byTempId.get(task.tempId.toUpperCase());
    if (!id) continue;
    const group = byWave.get(task.wave) ?? [];
    group.push(id);
    byWave.set(task.wave, group);
  }

  for (const task of tasks) {
    const issueId = byTempId.get(task.tempId.toUpperCase());
    if (!issueId) continue;

    if (task.explicitDependsOn.length > 0) {
      for (const depTempId of task.explicitDependsOn) {
        const dependsOnId = byTempId.get(depTempId);
        if (dependsOnId && dependsOnId !== issueId) edges.push({ issueId, dependsOnId, type: "depends_on" });
      }
      continue;
    }

    const priorWave = Math.max(...[...byWave.keys()].filter((wave) => wave < task.wave), 0);
    if (priorWave > 0) {
      for (const dependsOnId of byWave.get(priorWave) ?? []) {
        if (dependsOnId !== issueId) edges.push({ issueId, dependsOnId, type: "depends_on" });
      }
    }
  }

  return edges;
}

export async function materializeSpecTasksForWorkspace(
  workspaceId: string,
  database: Database,
  options?: { boardEvents?: BoardEvents; requireCurrentTasks?: boolean },
): Promise<MaterializeResult> {
  const workspaceRows = await database
    .select({
      issueId: workspaces.issueId,
      currentNodeId: workspaces.currentNodeId,
      nodeName: workflowNodes.name,
      projectId: issues.projectId,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .leftJoin(workflowNodes, eq(workspaces.currentNodeId, workflowNodes.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  const workspace = workspaceRows[0];
  if (!workspace || (options?.requireCurrentTasks !== false && workspace.nodeName?.toLowerCase() !== "tasks")) {
    return { created: [], dependencyEdges: 0, skipped: true, reason: "not-tasks-phase" };
  }

  const existingChildLinks = await database
    .select({ id: issueDependencies.id })
    .from(issueDependencies)
    .where(or(
      and(eq(issueDependencies.dependsOnId, workspace.issueId), eq(issueDependencies.type, "child_of")),
      and(eq(issueDependencies.issueId, workspace.issueId), eq(issueDependencies.type, "parent_of")),
    ))
    .limit(1);
  if (existingChildLinks.length > 0) {
    return { created: [], dependencyEdges: 0, skipped: true, reason: "already-materialized" };
  }

  const artifacts = await database
    .select({ content: issueArtifacts.content, createdAt: issueArtifacts.createdAt })
    .from(issueArtifacts)
    .where(and(eq(issueArtifacts.issueId, workspace.issueId), eq(issueArtifacts.caption, "phase-artifact:tasks")))
    .orderBy(sql`${issueArtifacts.createdAt} DESC`)
    .limit(1);
  const artifact = artifacts[0];
  if (!artifact?.content) {
    return { created: [], dependencyEdges: 0, skipped: true, reason: "missing-artifact" };
  }

  const parsedTasks = parseTasksArtifact(artifact.content);
  if (parsedTasks.length === 0) {
    return { created: [], dependencyEdges: 0, skipped: true, reason: "no-tasks-found" };
  }

  const now = new Date().toISOString();
  const created: MaterializeResult["created"] = [];
  let dependencyEdges = 0;

  await database.transaction(async (tx) => {
    const maxRow = await tx
      .select({ maxNum: sql<number | null>`max(${issues.issueNumber})` })
      .from(issues)
      .where(eq(issues.projectId, workspace.projectId));
    let nextNumber = (maxRow[0]?.maxNum ?? 0) + 1;

    const backlogRows = await tx
      .select({ id: projectStatuses.id })
      .from(projectStatuses)
      .where(and(eq(projectStatuses.projectId, workspace.projectId), eq(projectStatuses.name, "Backlog")))
      .limit(1);
    const defaultRows = backlogRows.length > 0
      ? backlogRows
      : await tx
          .select({ id: projectStatuses.id })
          .from(projectStatuses)
          .where(eq(projectStatuses.projectId, workspace.projectId))
          .orderBy(projectStatuses.sortOrder)
          .limit(1);
    const statusId = defaultRows[0]?.id;
    if (!statusId) throw new Error("No statuses found for project");

    for (const task of parsedTasks) {
      const id = randomUUID();
      const issueNumber = nextNumber++;
      await tx.insert(issues).values({
        id,
        issueNumber,
        title: task.title,
        description: task.description,
        priority: task.priority,
        issueType: "task",
        skipAutoReview: false,
        estimate: null,
        sortOrder: 0,
        statusId,
        projectId: workspace.projectId,
        createdAt: now,
        updatedAt: now,
      });
      created.push({ id, issueNumber, title: task.title, tempId: task.tempId });

      await tx.insert(issueDependencies).values({
        id: randomUUID(),
        issueId: id,
        dependsOnId: workspace.issueId,
        type: "child_of",
        createdAt: now,
      });
      dependencyEdges++;
    }

    const taskEdges = buildDependencyEdges(parsedTasks, created);
    const seen = new Set<string>();
    for (const edge of taskEdges) {
      const key = `${edge.issueId}|${edge.dependsOnId}|${edge.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await tx.insert(issueDependencies).values({
        id: randomUUID(),
        issueId: edge.issueId,
        dependsOnId: edge.dependsOnId,
        type: edge.type,
        createdAt: now,
      });
      dependencyEdges++;
    }
  });

  options?.boardEvents?.broadcast(workspace.projectId, "issue_created");
  options?.boardEvents?.broadcast(workspace.projectId, "dependency_added");

  return { created, dependencyEdges, skipped: false };
}
