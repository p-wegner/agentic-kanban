/**
 * Pure snapshot-diff for the live Multi-Repo Monitor (#84). Given the previous
 * and current matrix snapshots, report which repo × workspace cells changed state
 * so the panel can briefly flash them. Presentation-only — the matrix *semantics*
 * live in `multiRepoMatrix.ts` and are untouched here.
 */
import type { MatrixCell, MultiRepoMatrix } from "./multiRepoMatrix.js";

/**
 * A matrix plus the ordered workspace ids for its columns. The workspace id (not
 * the column index) is the stable identity — columns come and go as workspaces are
 * created/closed, so diffing by index would spuriously flag every cell after an
 * insertion/removal.
 */
export interface MatrixSnapshot {
  /** Column order — `workspaceIds[i]` owns `row.cells[i]` for every row. */
  workspaceIds: string[];
  matrix: MultiRepoMatrix;
}

/** Stable key for one repo × workspace cell. */
export function cellKey(repoKey: string, workspaceId: string): string {
  return `${repoKey}::${workspaceId}`;
}

/** Serialize a cell's observable state; `null` (repo not in workspace) is its own value. */
function serializeCell(cell: MatrixCell | null | undefined): string {
  return cell ? `${cell.state}:${cell.ahead}` : "none";
}

/** Map every repoKey::workspaceId → serialized cell for a snapshot. */
function buildCellMap(snapshot: MatrixSnapshot): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of snapshot.matrix.rows) {
    snapshot.workspaceIds.forEach((wsId, col) => {
      map.set(cellKey(row.key, wsId), serializeCell(row.cells[col]));
    });
  }
  return map;
}

/**
 * Set of `cellKey`s whose state differs between `prev` and `next`.
 *
 * - The first snapshot (`prev === null`) flags nothing — there is no prior state to
 *   have "changed" from, so opening the panel doesn't flash the whole grid.
 * - Cells for a workspace column that is brand-new in `next` are not flagged — the
 *   whole column just appeared (a new workspace header already signals it); flashing
 *   every cell in it is noise, not a state transition.
 * - Everything else — a cell that changed value, gained a value (`null` → state), or
 *   lost one (state → `null`) for a workspace present in both snapshots — is flagged.
 */
export function diffMultiRepoMatrix(
  prev: MatrixSnapshot | null,
  next: MatrixSnapshot,
): Set<string> {
  const changed = new Set<string>();
  if (!prev) return changed;

  const prevMap = buildCellMap(prev);
  const prevWorkspaces = new Set(prev.workspaceIds);

  for (const row of next.matrix.rows) {
    next.workspaceIds.forEach((wsId, col) => {
      // Skip columns that didn't exist before — a new workspace isn't a "change".
      if (!prevWorkspaces.has(wsId)) return;
      const key = cellKey(row.key, wsId);
      const nextVal = serializeCell(row.cells[col]);
      const prevVal = prevMap.get(key) ?? "none";
      if (prevVal !== nextVal) changed.add(key);
    });
  }
  return changed;
}
