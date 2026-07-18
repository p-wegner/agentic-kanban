/**
 * Pure matrix-building logic for the Multi-Repo Monitor panel (#82): registered
 * repos (leading + additional) as rows × active workspaces as columns, each cell
 * showing that workspace's merge state IN that repo, derived from
 * `GET /api/workspaces/:id/repo-merge-status` responses (one per workspace).
 */

/** Client mirror of the server's RepoMergeStatusEntry (#70). */
export interface RepoMergeStatusEntry {
  name: string | null;
  path: string;
  isLeading: boolean;
  hasWork: boolean;
  ahead: number;
  merged: boolean;
  stranded: boolean;
}

/** Client mirror of the server's RepoMergeStatus response (#70). */
export interface RepoMergeStatusResponse {
  branch: string | null;
  baseBranch: string;
  allMerged: boolean;
  repos: RepoMergeStatusEntry[];
}

export interface MatrixRepoInput {
  name: string | null;
  path: string;
  isLeading: boolean;
}

export interface MatrixWorkspaceInput {
  id: string;
  issueNumber: number | null;
  issueTitle: string | null;
  branch: string | null;
  status: string;
  mergedAt: string | null;
  /** null = the repo-merge-status fetch failed for this workspace. */
  repoStatus: RepoMergeStatusResponse | null;
  /** Workspace-level conflict flag (GET /api/workspaces/:id/conflicts), optional. */
  hasConflicts?: boolean;
}

export type MatrixCellState =
  | "no-change"
  | "ahead"
  | "merged"
  | "stranded"
  | "conflict"
  | "unknown";

export interface MatrixCell {
  state: MatrixCellState;
  ahead: number;
}

export interface MatrixRow {
  /** Normalized repo path — stable row key. */
  key: string;
  label: string;
  path: string;
  isLeading: boolean;
  /** One cell per workspace column; null = this workspace has no entry for the repo. */
  cells: (MatrixCell | null)[];
}

export interface MatrixSummary {
  repoCount: number;
  workspaceCount: number;
  /** Workspaces with at least one stranded or conflicted repo cell. */
  strandedWorkspaceCount: number;
  conflictWorkspaceCount: number;
}

export interface MultiRepoMatrix {
  rows: MatrixRow[];
  summary: MatrixSummary;
}

/** Normalize a repo path for comparison: forward slashes, no trailing slash, case-folded (Windows). */
export function normalizeRepoPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function repoBasename(p: string): string {
  const parts = normalizeRepoPath(p).split("/");
  return parts[parts.length - 1] || p;
}

/**
 * Derive one cell from a repo-merge-status entry. The server's `stranded` flag means
 * "has work not on base" regardless of workspace lifecycle; for an actively-working
 * workspace that is just normal in-flight work. The alarming variant is unlanded work
 * in a workspace that has already (partially) merged — remaining commits will not
 * land by themselves (#69). We split the two into "ahead" vs "stranded", and upgrade
 * to "conflict" when the workspace-level conflict check fired.
 */
function deriveCell(entry: RepoMergeStatusEntry, ws: MatrixWorkspaceInput): MatrixCell {
  if (entry.merged) return { state: "merged", ahead: 0 };
  if (!entry.hasWork) return { state: "no-change", ahead: 0 };
  if (ws.hasConflicts) return { state: "conflict", ahead: entry.ahead };
  const partiallyMerged =
    ws.mergedAt !== null || (ws.repoStatus?.repos.some((r) => r.merged) ?? false);
  return { state: partiallyMerged ? "stranded" : "ahead", ahead: entry.ahead };
}

/**
 * Build the repo × workspace matrix. `repos` is the registered set (leading repo
 * first by convention); repos referenced by a workspace's status but no longer
 * registered are appended as extra rows so their state stays visible.
 */
export function buildMultiRepoMatrix(
  repos: MatrixRepoInput[],
  workspaces: MatrixWorkspaceInput[],
): MultiRepoMatrix {
  const rows: MatrixRow[] = repos.map((r) => ({
    key: normalizeRepoPath(r.path),
    label: r.name ?? repoBasename(r.path),
    path: r.path,
    isLeading: r.isLeading,
    cells: workspaces.map(() => null),
  }));
  const byPath = new Map<string, number>(rows.map((row, i) => [row.key, i]));
  const leadingIndex = rows.findIndex((r) => r.isLeading);

  workspaces.forEach((ws, col) => {
    if (!ws.repoStatus) {
      for (const row of rows) row.cells[col] = { state: "unknown", ahead: 0 };
      return;
    }
    for (const entry of ws.repoStatus.repos) {
      const key = normalizeRepoPath(entry.path);
      let idx = entry.isLeading && leadingIndex >= 0 ? leadingIndex : byPath.get(key);
      if (idx === undefined) {
        rows.push({
          key,
          label: entry.name ?? repoBasename(entry.path),
          path: entry.path,
          isLeading: entry.isLeading,
          cells: workspaces.map(() => null),
        });
        byPath.set(key, rows.length - 1);
        idx = rows.length - 1;
      }
      rows[idx].cells[col] = deriveCell(entry, ws);
    }
  });

  const hasCellState = (col: number, states: MatrixCellState[]) =>
    rows.some((r) => {
      const cell = r.cells[col];
      return cell !== null && states.includes(cell.state);
    });

  const strandedWorkspaceCount = workspaces.filter((_, col) =>
    hasCellState(col, ["stranded", "conflict"]),
  ).length;
  const conflictWorkspaceCount = workspaces.filter((_, col) =>
    hasCellState(col, ["conflict"]),
  ).length;

  return {
    rows,
    summary: {
      repoCount: rows.length,
      workspaceCount: workspaces.length,
      strandedWorkspaceCount,
      conflictWorkspaceCount,
    },
  };
}
