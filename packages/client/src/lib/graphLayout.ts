import type { IssueWithStatus } from "@agentic-kanban/shared";
import { ACCENT } from "./chartColors.js";

export type DependencyType = "depends_on" | "blocked_by" | "related_to" | "duplicates" | "parent_of" | "child_of";

export const DEPENDENCY_TYPE_LABELS: Record<DependencyType, string> = {
  depends_on: "Depends on",
  blocked_by: "Blocked by",
  related_to: "Related to",
  duplicates: "Duplicates",
  parent_of: "Parent of",
  child_of: "Child of",
};

export interface Dependency {
  id: string;
  issueId: string;
  dependsOnId: string;
  type: DependencyType;
  issueTitle: string;
  issueStatusName: string;
  issueNumber: number | null;
}

export interface Node {
  id: string;
  x: number;
  y: number;
  issue: IssueWithStatus;
}

// Ordered workflow columns for status-based layout
export const STATUS_ORDER = ["Backlog", "Todo", "In Progress", "In Review", "AI Reviewed", "Done", "Cancelled"];

export const DEPENDENCY_COLORS: Record<DependencyType, string> = {
  depends_on: "#8a8175",
  blocked_by: "#b4453a",
  related_to: ACCENT,
  parent_of: "#c79a3e",
  child_of: "#c79a3e",
  duplicates: "#b07a8c",
};

/** Root blocker color — warm brick (same family as TYPE_COLORS.bug). */
export const ROOT_BLOCKER_COLOR = "#b4453a";
/** Critical-chain edge color. */
export const CHAIN_EDGE_COLOR = "#c25f36";
/** Cycle indicator color — amber. */
export const CYCLE_COLOR = "#f59e0b";

export const NODE_W = 220;
export const NODE_H = 64;
export const H_GAP = 48;
export const V_GAP = 16;
export const COL_HEADER_H = 28;
export const SWIMLANE_NODES_PER_ROW = 2;
export const DEPENDENCY_ROWS_PER_COLUMN = 8;
export const BAND_GAP = 64; // gap between status groups in swimlane layout

export function computeLayout(nodes: IssueWithStatus[], edges: Dependency[]): Node[] {
  if (nodes.length === 0) return [];

  const hasEdges = edges.length > 0;

  if (hasEdges) {
    // Dependency-based topological layout
    const outEdges = new Map<string, string[]>();
    const inDegree = new Map<string, number>();
    for (const n of nodes) {
      outEdges.set(n.id, []);
      inDegree.set(n.id, 0);
    }
    for (const e of edges) {
      if (outEdges.has(e.dependsOnId) && outEdges.has(e.issueId)) {
        outEdges.get(e.dependsOnId)!.push(e.issueId);
        inDegree.set(e.issueId, (inDegree.get(e.issueId) ?? 0) + 1);
      }
    }

    const levels = new Map<string, number>();
    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }
    while (queue.length > 0) {
      const id = queue.shift()!;
      const level = levels.get(id) ?? 0;
      for (const next of outEdges.get(id) ?? []) {
        const nextLevel = Math.max(levels.get(next) ?? 0, level + 1);
        levels.set(next, nextLevel);
        const deg = (inDegree.get(next) ?? 1) - 1;
        inDegree.set(next, deg);
        if (deg === 0) queue.push(next);
      }
    }
    for (const n of nodes) {
      if (!levels.has(n.id)) levels.set(n.id, 0);
    }

    const byLevel = new Map<number, IssueWithStatus[]>();
    for (const n of nodes) {
      const lv = levels.get(n.id) ?? 0;
      if (!byLevel.has(lv)) byLevel.set(lv, []);
      byLevel.get(lv)!.push(n);
    }

    const result: Node[] = [];
    const sortedLevels = Array.from(byLevel.keys()).sort((a, b) => a - b);
    let levelX = 40;
    for (const lv of sortedLevels) {
      const group = byLevel.get(lv)!;
      for (let i = 0; i < group.length; i++) {
        const subCol = Math.floor(i / DEPENDENCY_ROWS_PER_COLUMN);
        const row = i % DEPENDENCY_ROWS_PER_COLUMN;
        const x = levelX + subCol * (NODE_W + H_GAP);
        const y = row * (NODE_H + V_GAP) + 40;
        result.push({ id: group[i].id, x, y, issue: group[i] });
      }
      const levelCols = Math.max(1, Math.ceil(group.length / DEPENDENCY_ROWS_PER_COLUMN));
      levelX += levelCols * (NODE_W + H_GAP) + BAND_GAP;
    }
    return result;
  }

  // Status-based swimlane layout (no dependency edges)
  const byStatus = new Map<string, IssueWithStatus[]>();
  for (const n of nodes) {
    const s = n.statusName;
    if (!byStatus.has(s)) byStatus.set(s, []);
    byStatus.get(s)!.push(n);
  }

  // Order columns by STATUS_ORDER, then any remaining statuses alphabetically
  const knownOrder = STATUS_ORDER.filter((s) => byStatus.has(s));
  const extraStatuses = [...byStatus.keys()]
    .filter((s) => !STATUS_ORDER.includes(s))
    .sort();
  const orderedStatuses = [...knownOrder, ...extraStatuses];

  const result: Node[] = [];
  let swimlaneX = 40;
  for (let col = 0; col < orderedStatuses.length; col++) {
    const status = orderedStatuses[col];
    const group = byStatus.get(status)!;
    for (let i = 0; i < group.length; i++) {
      const subCol = i % SWIMLANE_NODES_PER_ROW;
      const row = Math.floor(i / SWIMLANE_NODES_PER_ROW);
      const x = swimlaneX + subCol * (NODE_W + H_GAP);
      const y = row * (NODE_H + V_GAP) + COL_HEADER_H + 48;
      result.push({ id: group[i].id, x, y, issue: group[i] });
    }
    const subCols = Math.min(group.length, SWIMLANE_NODES_PER_ROW);
    swimlaneX += subCols * (NODE_W + H_GAP) + BAND_GAP;
  }
  return result;
}

/** Column headers for the status-based layout (no edges mode) */
export function computeColumns(nodes: IssueWithStatus[], edges: Dependency[]) {
  if (edges.length > 0 || nodes.length === 0) return [];
  const byStatus = new Map<string, number>();
  for (const n of nodes) {
    byStatus.set(n.statusName, (byStatus.get(n.statusName) ?? 0) + 1);
  }
  const knownOrder = STATUS_ORDER.filter((s) => byStatus.has(s));
  const extraStatuses = [...byStatus.keys()]
    .filter((s) => !STATUS_ORDER.includes(s))
    .sort();
  const orderedStatuses = [...knownOrder, ...extraStatuses];
  const result = [];
  let swimlaneX = 40;
  for (const status of orderedStatuses) {
    const count = byStatus.get(status) ?? 0;
    result.push({ status, count, x: swimlaneX });
    const subCols = Math.min(count, SWIMLANE_NODES_PER_ROW);
    swimlaneX += subCols * (NODE_W + H_GAP) + BAND_GAP;
  }
  return result;
}

export function orderedStatusNames(statusNames: string[]) {
  const unique = [...new Set(statusNames)];
  const knownOrder = STATUS_ORDER.filter((s) => unique.includes(s));
  const extraStatuses = unique
    .filter((s) => !STATUS_ORDER.includes(s))
    .sort();
  return [...knownOrder, ...extraStatuses];
}
