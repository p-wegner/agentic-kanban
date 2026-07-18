// Repo-aware ticket authoring (#94): a ticket declares the repos it touches, and an
// epic can fan its children out across a multi-repo project's repos. The storage
// mechanism is the existing global tag system — a repo `foo` is represented by a
// `repo:foo` tag — so NO schema migration is needed and the chips render for free
// through the normal tag path on the issue card/detail.
//
// This module is pure (no node/DB imports) so it is shared verbatim by the server
// (apply tags, validate decompose suggestions) and the client (build the "Repos
// touched" selector, render/read repo chips, the decompose repo dropdown).

/** Every repo tag is `repo:<name>`. */
export const REPO_TAG_PREFIX = "repo:";

/** Sky — the same hue used for repo-scoped UI elsewhere in the multi-repo views. */
export const REPO_TAG_COLOR = "#0EA5E9";

/** The tag name that represents a repo, e.g. `repo:web`. */
export function repoTagName(repo: string): string {
  return `${REPO_TAG_PREFIX}${repo.trim()}`;
}

/** True for a `repo:<name>` tag with a non-empty name. */
export function isRepoTagName(name: string): boolean {
  return name.startsWith(REPO_TAG_PREFIX) && name.length > REPO_TAG_PREFIX.length;
}

/** The bare repo name from a `repo:<name>` tag, or null if it isn't a repo tag. */
export function repoNameFromTag(name: string): string | null {
  return isRepoTagName(name) ? name.slice(REPO_TAG_PREFIX.length) : null;
}

/** Last path segment (handles both `/` and `\`), lower-cased. Used to loosen matching
 *  when the AI answers with a path or `owner/repo` instead of the bare repo name. */
function baseName(value: string): string {
  const segments = value.split(/[/\\]/).filter(Boolean);
  return (segments[segments.length - 1] ?? value).toLowerCase();
}

/**
 * Resolve an AI-suggested repo string to the CANONICAL name from the project's known
 * repos, or null when it doesn't match any. Matching is case-insensitive on the full
 * name first, then on the last path segment (so `apps/web` or `me/web` both resolve to
 * a known `web`). Returning the canonical spelling keeps the applied `repo:` tag stable.
 */
export function resolveRepoName(
  suggested: string | null | undefined,
  knownRepos: string[],
): string | null {
  if (!suggested) return null;
  const s = suggested.trim().toLowerCase();
  if (!s) return null;
  const exact = knownRepos.find((r) => r.toLowerCase() === s);
  if (exact) return exact;
  const target = baseName(s);
  const byBase = knownRepos.find((r) => baseName(r) === target || r.toLowerCase() === target);
  return byBase ?? null;
}

export interface RepoChildSuggestion {
  tempId: string;
  /** The repo the AI proposed for this child (free-form; validated here). */
  targetRepo?: string | null;
}

/**
 * The decompose repo-assignment mapping: validate each child's AI-proposed repo against
 * the project's known repos and return a `tempId -> canonical repo name` map for the
 * children that resolved. Children with no suggestion or an unknown one are omitted
 * (left unassigned — editable before confirm).
 *
 * Repo routing is a multi-repo-only concern: with fewer than two known repos the map is
 * always empty, so single-repo projects see no behaviour change.
 */
export function assignChildRepos(
  children: RepoChildSuggestion[],
  knownRepos: string[],
): Map<string, string> {
  const assignment = new Map<string, string>();
  if (knownRepos.length < 2) return assignment;
  for (const child of children) {
    const resolved = resolveRepoName(child.targetRepo, knownRepos);
    if (resolved) assignment.set(child.tempId, resolved);
  }
  return assignment;
}
