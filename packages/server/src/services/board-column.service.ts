import { isResolvedDependencyStatusView } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import { buildAdjacency, wouldCreateCycle as graphWouldCreateCycle } from "../lib/dependency-graph.js";
import {
  getDependencyRowsForIssues,
  getDependencyStatusViews,
  getGraphEdgesForIssues,
  getProjectDependencyEdges,
  getTagRowsForIssues,
  type GraphEdge,
} from "../repositories/board-column.repository.js";

export type { GraphEdge };

export async function buildBlockedMap(
  issueIds: string[],
  database: Database,
): Promise<Map<string, { isBlocked: boolean; dependencyCount: number }>> {
  const result = new Map<string, { isBlocked: boolean; dependencyCount: number }>();
  if (issueIds.length === 0) return result;

  const depRows = await getDependencyRowsForIssues(issueIds, database);

  const dependsOnIds = [...new Set(depRows.map(d => d.dependsOnId))];
  const depStatusMap = new Map<string, { currentNodeId: string | null; currentNodeType: string | null; statusName: string }>();
  if (dependsOnIds.length > 0) {
    const depStatuses = await getDependencyStatusViews(dependsOnIds, database);
    for (const ds of depStatuses) depStatusMap.set(ds.id, ds);
  }

  const depsByIssue = new Map<string, { dependsOnId: string; type: string }[]>();
  for (const dep of depRows) {
    let arr = depsByIssue.get(dep.issueId);
    if (!arr) { arr = []; depsByIssue.set(dep.issueId, arr); }
    arr.push({ dependsOnId: dep.dependsOnId, type: dep.type });
  }

  for (const [issueId, deps] of depsByIssue) {
    const isBlocked = deps.some(dep => {
      if (dep.type !== "depends_on" && dep.type !== "blocked_by") return false;
      const blocker = depStatusMap.get(dep.dependsOnId);
      return blocker ? !isResolvedDependencyStatusView(blocker) : true;
    });
    result.set(issueId, { isBlocked, dependencyCount: deps.length });
  }

  return result;
}

export async function buildTagMap(
  issueIds: string[],
  database: Database,
): Promise<Map<string, { id: string; name: string; color: string | null }[]>> {
  const tagMap = new Map<string, { id: string; name: string; color: string | null }[]>();
  if (issueIds.length === 0) return tagMap;

  const tagRows = await getTagRowsForIssues(issueIds, database);

  for (const row of tagRows) {
    let arr = tagMap.get(row.issueId);
    if (!arr) { arr = []; tagMap.set(row.issueId, arr); }
    arr.push({ id: row.id, name: row.name, color: row.color });
  }

  return tagMap;
}

/** Fetch all dependency edges for a set of issue IDs. */
export async function buildGraphEdges(issueIds: string[], database: Database): Promise<GraphEdge[]> {
  return getGraphEdgesForIssues(issueIds, database);
}

/**
 * DFS cycle check. Returns true if adding the edge issueId->dependsOnId would
 * create a cycle in the project dependency graph.
 */
export async function wouldCreateCycle(database: Database, issueId: string, dependsOnId: string, projectId: string): Promise<boolean> {
  const allDeps = await getProjectDependencyEdges(projectId, database);
  const adj = buildAdjacency(allDeps.map(dep => ({ from: dep.depIssueId, to: dep.depDependsOnId })));
  return graphWouldCreateCycle(adj, issueId, dependsOnId);
}
