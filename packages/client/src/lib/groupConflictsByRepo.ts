// Since #76 the board's per-workspace `conflicts.conflictingFiles` folds in SIBLING
// repo conflicts, namespaced `repoName::file` (the leading repo's files stay
// un-namespaced). This pure helper parses that prefix back out and groups the files
// by repo so the board card conflict badge/tooltip can reveal WHICH repo conflicts
// instead of showing a single opaque total.
//
// The un-prefixed (leading-repo) files are grouped under the sentinel label below.
// Namespacing is done with the first `::` (see board-status-enrichment.ts), so we
// split on the first occurrence only — a repo name never contains `::`, but a path
// theoretically could, so keep the remainder intact.

/** Label for the un-namespaced (leading-repo) conflict group. */
export const LEADING_REPO_LABEL = "leading";

export interface RepoConflictGroup {
  /** Repo name parsed from the `name::file` prefix, or {@link LEADING_REPO_LABEL} for un-prefixed files. */
  repo: string;
  /** The conflicting file paths within this repo, with the namespace prefix stripped. */
  files: string[];
}

export interface GroupedConflicts {
  /** Groups ordered siblings-alphabetical first, leading last (matches the badge summary). */
  groups: RepoConflictGroup[];
  /** Total conflicting files across all repos. */
  total: number;
}

/**
 * Group a flat `conflictingFiles` list by repo. Un-prefixed entries land in the
 * {@link LEADING_REPO_LABEL} group; `name::file` entries land under `name`.
 * Ordering: sibling repos alphabetically, then the leading group last, so the
 * compact summary reads e.g. "auth-svc 2, leading 1".
 */
export function groupConflictsByRepo(conflictingFiles: readonly string[]): GroupedConflicts {
  const byRepo = new Map<string, string[]>();
  for (const entry of conflictingFiles) {
    const idx = entry.indexOf("::");
    const repo = idx === -1 ? LEADING_REPO_LABEL : entry.slice(0, idx);
    const file = idx === -1 ? entry : entry.slice(idx + 2);
    const bucket = byRepo.get(repo);
    if (bucket) bucket.push(file);
    else byRepo.set(repo, [file]);
  }

  const siblings = [...byRepo.keys()]
    .filter((r) => r !== LEADING_REPO_LABEL)
    .sort((a, b) => a.localeCompare(b));
  const ordered = [...siblings, ...(byRepo.has(LEADING_REPO_LABEL) ? [LEADING_REPO_LABEL] : [])];

  const groups = ordered.map((repo) => ({ repo, files: byRepo.get(repo)! }));
  const total = conflictingFiles.length;
  return { groups, total };
}

/** Compact per-repo count summary, e.g. "auth-svc 2, leading 1". Empty string when no conflicts. */
export function formatConflictSummary(grouped: GroupedConflicts): string {
  return grouped.groups.map((g) => `${g.repo} ${g.files.length}`).join(", ");
}
