// Drive membership derivation (#1135).
//
// A drive is invisible from the tickets it owns: `drive-dashboard.service.ts` resolves an
// epic's subtree only when asked for ONE drive's dashboard. This module derives the same
// scope for EVERY active drive in a project at once, cheaply enough to run on every board
// build — one project-scoped dependency-edge query (not resolveDriveIssueIds's whole-DB BFS)
// plus a linear scan per issue against a project-sized adjacency map.
//
// Derivation over storage is deliberate (see the drives.metaIssueId column comment): a second
// stored edge on every child would be a drift source against the single `meta_issue_id` pointer.
import type { Database } from "../db/index.js";
import { listDrivesByProject } from "../repositories/drive.repository.js";
import { getProjectDependencyEdgesTyped } from "../repositories/drive-dashboard.repository.js";

export interface IssueDriveInfo {
  id: string;
  target: string;
}

/**
 * Build a map from issue id -> owning drive, for every ACTIVE drive in the project that has a
 * meta issue. Scope = the meta issue's direct `parent_of` children, falling back to every
 * outgoing edge for a hand-wired drive — the same rule `drive-dashboard.service.ts`'s
 * `loadScopedIssues` uses for one drive's dashboard, applied here to every drive at once.
 *
 * An issue in more than one drive's scope (not expected in practice — drives are seeded from
 * disjoint epics) keeps whichever drive is encountered first; deterministic because drives are
 * read in `listDrivesByProject`'s fixed (most-recently-started-first) order.
 */
export async function buildDriveMap(
  projectId: string,
  database: Database,
): Promise<Map<string, IssueDriveInfo>> {
  const result = new Map<string, IssueDriveInfo>();

  const drives = (await listDrivesByProject(projectId, database)).filter(
    (d) => d.status === "active" && d.metaIssueId,
  );
  if (drives.length === 0) return result;

  const edges = await getProjectDependencyEdgesTyped(projectId, database);
  // Outgoing edges by source issue id, split by type so a drive prefers its `parent_of`
  // children exactly as the single-drive dashboard does. One project-scoped query serves
  // every drive, instead of resolveDriveIssueIds's per-drive whole-DB BFS.
  const parentOfByIssue = new Map<string, string[]>();
  const anyByIssue = new Map<string, string[]>();
  for (const e of edges) {
    anyByIssue.set(e.issueId, [...(anyByIssue.get(e.issueId) ?? []), e.dependsOnId]);
    if (e.type === "parent_of") {
      parentOfByIssue.set(e.issueId, [...(parentOfByIssue.get(e.issueId) ?? []), e.dependsOnId]);
    }
  }

  for (const drive of drives) {
    const metaIssueId = drive.metaIssueId as string;
    const scopedIds = parentOfByIssue.get(metaIssueId) ?? anyByIssue.get(metaIssueId) ?? [];
    const info: IssueDriveInfo = { id: drive.id, target: drive.target };
    if (!result.has(metaIssueId)) result.set(metaIssueId, info);
    for (const id of scopedIds) {
      if (!result.has(id)) result.set(id, info);
    }
  }

  return result;
}
