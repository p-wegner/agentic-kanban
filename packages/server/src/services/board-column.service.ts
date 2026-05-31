import { isResolvedDependencyStatusView } from "@agentic-kanban/shared";
import { issues, projectStatuses, issueDependencies, tags, issueTags, workflowNodes } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import type { Database } from "../db/index.js";

export type GraphEdge = {
  id: string;
  issueId: string;
  dependsOnId: string;
  type: string;
  issueTitle: string;
  issueStatusName: string;
  issueNumber: number | null;
};

export async function buildBlockedMap(
  issueIds: string[],
  database: Database,
): Promise<Map<string, { isBlocked: boolean; dependencyCount: number }>> {
  const result = new Map<string, { isBlocked: boolean; dependencyCount: number }>();
  if (issueIds.length === 0) return result;

  const depRows = await database
    .select({
      issueId: issueDependencies.issueId,
      dependsOnId: issueDependencies.dependsOnId,
      type: issueDependencies.type,
    })
    .from(issueDependencies)
    .where(inArray(issueDependencies.issueId, issueIds));

  const dependsOnIds = [...new Set(depRows.map(d => d.dependsOnId))];
  const depStatusMap = new Map<string, { currentNodeId: string | null; currentNodeType: string | null; statusName: string }>();
  if (dependsOnIds.length > 0) {
    const depStatuses = await database
      .select({
        id: issues.id,
        currentNodeId: issues.currentNodeId,
        currentNodeType: workflowNodes.nodeType,
        statusName: projectStatuses.name,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
      .where(inArray(issues.id, dependsOnIds));
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

  const tagRows = await database
    .select({ issueId: issueTags.issueId, id: tags.id, name: tags.name, color: tags.color })
    .from(issueTags)
    .innerJoin(tags, eq(issueTags.tagId, tags.id))
    .where(inArray(issueTags.issueId, issueIds));

  for (const row of tagRows) {
    let arr = tagMap.get(row.issueId);
    if (!arr) { arr = []; tagMap.set(row.issueId, arr); }
    arr.push({ id: row.id, name: row.name, color: row.color });
  }

  return tagMap;
}

/** Fetch all dependency edges for a set of issue IDs. */
export async function buildGraphEdges(issueIds: string[], database: Database): Promise<GraphEdge[]> {
  if (issueIds.length === 0) return [];
  return database
    .select({
      id: issueDependencies.id,
      issueId: issueDependencies.issueId,
      dependsOnId: issueDependencies.dependsOnId,
      type: issueDependencies.type,
      issueTitle: issues.title,
      issueStatusName: projectStatuses.name,
      issueNumber: issues.issueNumber,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(inArray(issueDependencies.issueId, issueIds));
}

/**
 * DFS cycle check. Returns true if adding the edge issueId->dependsOnId would
 * create a cycle in the project dependency graph.
 */
export async function wouldCreateCycle(database: Database, issueId: string, dependsOnId: string, projectId: string): Promise<boolean> {
  const allDeps = await database
    .select({
      depIssueId: issueDependencies.issueId,
      depDependsOnId: issueDependencies.dependsOnId,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .where(eq(issues.projectId, projectId));

  const adj = new Map<string, Set<string>>();
  for (const dep of allDeps) {
    let set = adj.get(dep.depIssueId);
    if (!set) { set = new Set(); adj.set(dep.depIssueId, set); }
    set.add(dep.depDependsOnId);
  }

  const visited = new Set<string>();
  const stack = [dependsOnId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === issueId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const neighbors = adj.get(current);
    if (neighbors) {
      for (const n of neighbors) stack.push(n);
    }
  }
  return false;
}
