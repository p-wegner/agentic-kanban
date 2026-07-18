/**
 * Pure aggregation for the Cross-Repo Change-Impact Heatmap (#97): a matrix of
 * active workspaces (rows) × registered repos (cols), each cell coloured by change
 * intensity (files touched / lines changed) for that workspace in that repo.
 *
 * Sourced entirely from data the board already returns per workspace — the
 * multi-repo `GET /diff` sections (`DiffResponse.repos[].stats`) for intensity, and
 * the file-contention endpoint (workspace pairs sharing a contested file) for the
 * "contended" marker. No new server endpoint; this module only maps existing
 * summaries into intensity buckets and derived flags, so it is trivially testable.
 */
import { normalizeRepoPath } from "./multiRepoMatrix.js";

/** Ordered, coarse change-intensity buckets. `none` = the workspace didn't touch the repo. */
export type IntensityBucket = "none" | "low" | "medium" | "high" | "severe";

/** Numeric rank of a bucket (0 = none … 4 = severe) — used for column totals + max-of. */
export const BUCKET_SCORE: Record<IntensityBucket, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  severe: 4,
};

const SCORE_BUCKET: IntensityBucket[] = ["none", "low", "medium", "high", "severe"];

/** A registered repo — one heatmap column. */
export interface ImpactRepoInput {
  name: string | null;
  path: string;
  isLeading: boolean;
}

/** One repo's diff summary for a single workspace (from `DiffResponse.repos[].stats`). */
export interface WorkspaceRepoDiff {
  /** Repo path this section belongs to (matched to a column by normalized path). */
  path: string;
  name?: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** One active workspace — one heatmap row. */
export interface ImpactWorkspaceInput {
  id: string;
  issueId?: string;
  issueNumber: number | null;
  issueTitle: string | null;
  branch: string | null;
  status: string;
  /** Per-repo diff summaries for this workspace. Empty = no committed change anywhere. */
  repoDiffs: WorkspaceRepoDiff[];
}

/**
 * A pair of active workspaces that share at least one contested file, from the
 * file-contention endpoint. The contention data isn't repo-attributed, so we
 * localise the overlap to the repo(s) both workspaces actually changed (below).
 */
export interface WorkspaceOverlap {
  a: string;
  b: string;
}

export interface ImpactCell {
  repoKey: string;
  workspaceId: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** insertions + deletions. */
  linesChanged: number;
  bucket: IntensityBucket;
  /** BUCKET_SCORE[bucket], 0…4. */
  score: number;
  /** This workspace shares a contested file with another workspace that also changed this repo. */
  contended: boolean;
}

export interface ImpactRow {
  workspaceId: string;
  issueId?: string;
  issueNumber: number | null;
  issueTitle: string | null;
  branch: string | null;
  status: string;
  /** One cell per column, aligned to `CrossRepoImpact.columns` order. */
  cells: ImpactCell[];
  /** Repos this workspace touched (bucket !== "none"). */
  reposTouched: number;
  /** Cross-cutting = touches ≥ 2 repos (collision / coordination risk). */
  crossCutting: boolean;
  /** Sum of cell scores across repos — row "weight". */
  totalScore: number;
}

export interface ImpactColumn {
  /** Normalized repo path — stable column key. */
  key: string;
  label: string;
  path: string;
  isLeading: boolean;
  /** Workspaces with a non-none cell in this repo. */
  touchingWorkspaceCount: number;
  totalFilesChanged: number;
  totalLinesChanged: number;
  totalScore: number;
  /** Hot = change concentrates here: ≥ 2 workspaces touch it, or heavy line churn. */
  hot: boolean;
  /** At least one contended cell in this repo. */
  contended: boolean;
}

export interface CrossRepoImpact {
  columns: ImpactColumn[];
  rows: ImpactRow[];
  summary: {
    repoCount: number;
    workspaceCount: number;
    /** Rows touching ≥ 2 repos. */
    crossCuttingCount: number;
    hotRepoCount: number;
    contendedRepoCount: number;
  };
}

/** A repo becomes "hot" on line churn alone once its column total crosses this. */
export const HOT_LINES_THRESHOLD = 300;

function bucketForFiles(files: number): number {
  if (files <= 0) return 0;
  if (files <= 2) return 1;
  if (files <= 5) return 2;
  if (files <= 15) return 3;
  return 4;
}

function bucketForLines(lines: number): number {
  if (lines <= 0) return 0;
  if (lines <= 20) return 1;
  if (lines <= 100) return 2;
  if (lines <= 500) return 3;
  return 4;
}

/**
 * Map a cell's raw diff counts to an intensity bucket. Both dimensions vote and the
 * stronger wins, so a huge single-file rewrite ranks as high as a sprawl of tiny
 * edits. Zero change on both axes is `none`.
 */
export function intensityBucket(filesChanged: number, linesChanged: number): IntensityBucket {
  const score = Math.max(bucketForFiles(filesChanged), bucketForLines(linesChanged));
  return SCORE_BUCKET[score];
}

/**
 * Build the workspace × repo change-impact matrix. Columns are the registered repos
 * (leading first by convention); a repo a workspace changed but that isn't registered
 * is appended as an extra column so its activity stays visible. Contention overlaps
 * are localised to the repo(s) both workspaces actually changed.
 */
export function buildCrossRepoImpact(
  repos: ImpactRepoInput[],
  workspaces: ImpactWorkspaceInput[],
  overlaps: WorkspaceOverlap[] = [],
): CrossRepoImpact {
  const columns: ImpactColumn[] = repos.map((r) => ({
    key: normalizeRepoPath(r.path),
    label: r.name ?? repoBasename(r.path),
    path: r.path,
    isLeading: r.isLeading,
    touchingWorkspaceCount: 0,
    totalFilesChanged: 0,
    totalLinesChanged: 0,
    totalScore: 0,
    hot: false,
    contended: false,
  }));
  const colIndex = new Map<string, number>(columns.map((c, i) => [c.key, i]));

  // Fold each workspace's repo diffs by normalized path (summing defensive dups), and
  // register any touched-but-unregistered repo as a trailing column so it stays visible.
  const foldedByWorkspace = workspaces.map((ws) => {
    const byKey = new Map<string, WorkspaceRepoDiff>();
    for (const rd of ws.repoDiffs) {
      const key = normalizeRepoPath(rd.path);
      const prev = byKey.get(key);
      if (prev) {
        prev.filesChanged += rd.filesChanged;
        prev.insertions += rd.insertions;
        prev.deletions += rd.deletions;
      } else {
        byKey.set(key, { ...rd });
      }
      if (!colIndex.has(key)) {
        columns.push({
          key,
          label: rd.name ?? repoBasename(rd.path),
          path: rd.path,
          isLeading: false,
          touchingWorkspaceCount: 0,
          totalFilesChanged: 0,
          totalLinesChanged: 0,
          totalScore: 0,
          hot: false,
          contended: false,
        });
        colIndex.set(key, columns.length - 1);
      }
    }
    return byKey;
  });

  // Second pass: every column now known — build aligned cells + column totals.
  // A workspace "touched" a repo iff its cell there is non-none (for overlap localising).
  const touchedByWorkspace = new Map<string, Set<string>>();
  const rows: ImpactRow[] = workspaces.map((ws, i) => {
    const byKey = foldedByWorkspace[i];
    const touched = new Set<string>();
    touchedByWorkspace.set(ws.id, touched);
    let reposTouched = 0;
    let totalScore = 0;
    const cells: ImpactCell[] = columns.map((col) => {
      const rd = byKey.get(col.key);
      const filesChanged = rd?.filesChanged ?? 0;
      const insertions = rd?.insertions ?? 0;
      const deletions = rd?.deletions ?? 0;
      const linesChanged = insertions + deletions;
      const bucket = intensityBucket(filesChanged, linesChanged);
      const score = BUCKET_SCORE[bucket];
      if (bucket !== "none") {
        reposTouched += 1;
        totalScore += score;
        touched.add(col.key);
        col.touchingWorkspaceCount += 1;
        col.totalFilesChanged += filesChanged;
        col.totalLinesChanged += linesChanged;
        col.totalScore += score;
      }
      return {
        repoKey: col.key,
        workspaceId: ws.id,
        filesChanged,
        insertions,
        deletions,
        linesChanged,
        bucket,
        score,
        contended: false,
      };
    });
    return {
      workspaceId: ws.id,
      issueId: ws.issueId,
      issueNumber: ws.issueNumber,
      issueTitle: ws.issueTitle,
      branch: ws.branch,
      status: ws.status,
      cells,
      reposTouched,
      crossCutting: reposTouched >= 2,
      totalScore,
    };
  });

  // Localise contention: for each overlapping pair, flag the cells of any repo BOTH
  // workspaces changed. That reuses file-contention (workspace pairs sharing a file)
  // plus the diff (which repos each touched) to mark "same-repo overlap" collision zones.
  const cellByKey = new Map<string, ImpactCell>();
  for (const row of rows) {
    for (const cell of row.cells) cellByKey.set(`${cell.repoKey}::${cell.workspaceId}`, cell);
  }
  for (const { a, b } of overlaps) {
    const ta = touchedByWorkspace.get(a);
    const tb = touchedByWorkspace.get(b);
    if (!ta || !tb) continue;
    for (const key of ta) {
      if (!tb.has(key)) continue;
      const ca = cellByKey.get(`${key}::${a}`);
      const cb = cellByKey.get(`${key}::${b}`);
      if (ca) ca.contended = true;
      if (cb) cb.contended = true;
      const col = columns[colIndex.get(key)!];
      if (col) col.contended = true;
    }
  }

  for (const col of columns) {
    col.hot = col.touchingWorkspaceCount >= 2 || col.totalLinesChanged >= HOT_LINES_THRESHOLD;
  }

  return {
    columns,
    rows,
    summary: {
      repoCount: columns.length,
      workspaceCount: workspaces.length,
      crossCuttingCount: rows.filter((r) => r.crossCutting).length,
      hotRepoCount: columns.filter((c) => c.hot).length,
      contendedRepoCount: columns.filter((c) => c.contended).length,
    },
  };
}

function repoBasename(p: string): string {
  const parts = normalizeRepoPath(p).split("/");
  return parts[parts.length - 1] || p;
}
