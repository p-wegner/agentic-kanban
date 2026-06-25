/**
 * Deterministic touched-file overlap → coupling-candidate detection (#917).
 *
 * The "detect" half of the contraction epic. Reuses the already-cached
 * AI-predicted touched files (`issues.touched_files_json`, produced by
 * `analyzeTouchedFiles`) to surface peer COUPLING between backlog tickets:
 * two issues whose predicted file sets overlap above a threshold are
 * "coupling candidates" — best implemented together, i.e. `coupled_with`.
 *
 * This module is PURE (no node builtins, no DB) so it is client-bundle safe and
 * unit-testable in isolation. The server feeds these candidates into
 * `analyzeDependencies` both as prompt context AND as deterministic
 * `coupled_with` proposals — never auto-applied; the threshold is configurable.
 */

/** One issue's predicted touched files, as needed for overlap. */
export interface IssueTouchedFiles {
  issueId: string;
  /** Distinct file paths predicted for this issue. */
  files: string[];
}

/** A detected coupling candidate pair, with the shared files driving it. */
export interface CouplingCandidate {
  /** The two coupled issue ids, sorted (stable, direction-agnostic — coupling is symmetric). */
  issueIds: [string, string];
  /** The file paths both issues are predicted to touch. */
  sharedFiles: string[];
  /**
   * Overlap strength in [0,1]: |intersection| / |smaller predicted set| (the
   * Szymkiewicz–Simpson overlap coefficient). Using the smaller set means a
   * small focused ticket fully contained in a larger one's footprint scores 1.0.
   */
  overlapScore: number;
}

export interface ComputeCouplingOptions {
  /**
   * Minimum overlap score (0..1) for a pair to be a candidate. Default 0.5.
   * Configurable via the `coupling_overlap_threshold` setting.
   */
  threshold?: number;
  /** Minimum number of shared files required regardless of score. Default 1. */
  minSharedFiles?: number;
}

export const DEFAULT_COUPLING_OVERLAP_THRESHOLD = 0.5;

function normalizePath(p: string): string {
  // Predicted paths come from the model — normalise slashes and trim so that
  // "src/a.ts" and "src\\a.ts" count as the same file.
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Distinct, normalised, non-empty file set for an issue. */
function fileSet(files: string[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    const n = normalizePath(f);
    if (n) out.add(n);
  }
  return out;
}

/**
 * Compute coupling candidate pairs from per-issue predicted touched files.
 *
 * Pairs are considered ONLY when both issues have at least one predicted file.
 * Results are deterministic: candidate issue ids are sorted within each pair,
 * shared files are sorted, and pairs are ordered by descending overlap score
 * then by issue ids.
 */
export function computeCouplingCandidates(
  issues: IssueTouchedFiles[],
  options: ComputeCouplingOptions = {},
): CouplingCandidate[] {
  const threshold = options.threshold ?? DEFAULT_COUPLING_OVERLAP_THRESHOLD;
  const minSharedFiles = options.minSharedFiles ?? 1;

  const sets = issues
    .map((i) => ({ issueId: i.issueId, files: fileSet(i.files) }))
    .filter((i) => i.files.size > 0);

  const candidates: CouplingCandidate[] = [];

  for (let a = 0; a < sets.length; a++) {
    for (let b = a + 1; b < sets.length; b++) {
      const A = sets[a];
      const B = sets[b];
      const shared: string[] = [];
      // Intersect over the smaller set for efficiency.
      const [small, large] = A.files.size <= B.files.size ? [A.files, B.files] : [B.files, A.files];
      for (const f of small) {
        if (large.has(f)) shared.push(f);
      }
      if (shared.length < minSharedFiles) continue;

      const overlapScore = shared.length / small.size;
      if (overlapScore < threshold) continue;

      const issueIds: [string, string] = A.issueId < B.issueId
        ? [A.issueId, B.issueId]
        : [B.issueId, A.issueId];

      candidates.push({
        issueIds,
        sharedFiles: shared.sort(),
        overlapScore,
      });
    }
  }

  candidates.sort((x, y) => {
    if (y.overlapScore !== x.overlapScore) return y.overlapScore - x.overlapScore;
    if (x.issueIds[0] !== y.issueIds[0]) return x.issueIds[0] < y.issueIds[0] ? -1 : 1;
    return x.issueIds[1] < y.issueIds[1] ? -1 : 1;
  });

  return candidates;
}

/**
 * Candidates that involve a given target issue, returned as the OTHER issue id
 * plus the shared files. Used by `analyzeDependencies`, which is scoped to one
 * target issue.
 */
export function couplingCandidatesFor(
  targetIssueId: string,
  candidates: CouplingCandidate[],
): Array<{ otherIssueId: string; sharedFiles: string[]; overlapScore: number }> {
  const out: Array<{ otherIssueId: string; sharedFiles: string[]; overlapScore: number }> = [];
  for (const c of candidates) {
    if (c.issueIds[0] === targetIssueId) {
      out.push({ otherIssueId: c.issueIds[1], sharedFiles: c.sharedFiles, overlapScore: c.overlapScore });
    } else if (c.issueIds[1] === targetIssueId) {
      out.push({ otherIssueId: c.issueIds[0], sharedFiles: c.sharedFiles, overlapScore: c.overlapScore });
    }
  }
  return out;
}
