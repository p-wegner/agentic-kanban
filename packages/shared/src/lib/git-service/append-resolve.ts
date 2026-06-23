import { execGit } from "./internal.js";

/** Read a blob's content at a given tree-ish path; returns null when the path is absent there. */
export async function readBlobAtRef(repoPath: string, ref: string, path: string): Promise<string | null> {
  try {
    return await execGit(["show", `${ref}:${path}`], repoPath);
  } catch {
    return null;
  }
}

/**
 * Decide whether a single file's conflict is a *pure append* and, if so, compute the
 * concatenated resolution. A pure-append conflict is one where the merge-base content
 * is a textual PREFIX of BOTH the target and feature versions — i.e. each side only
 * added lines at the tail and neither edited any existing line. The resolution keeps
 * the shared base, then appends the target's new tail followed by the feature's new
 * tail (target-first is deterministic and matches "base already advanced, replay
 * feature's addition after it"). Returns null when the file isn't a pure append.
 */
export function resolveAppendOnlyFile(base: string | null, target: string | null, feature: string | null): string | null {
  // A brand-new file added on both sides (no common ancestor) is an add/add conflict,
  // not an append — skip (we can't know a safe order).
  if (base === null || target === null || feature === null) return null;
  if (!target.startsWith(base) || !feature.startsWith(base)) return null;
  const targetTail = target.slice(base.length);
  const featureTail = feature.slice(base.length);
  // Both unchanged would not have conflicted; if exactly one changed, git merges it
  // cleanly without a conflict — so by the time we're here both tails are non-empty.
  // Guard `base` ending without a trailing newline so the concatenation doesn't glue
  // the base's last line onto the first appended line.
  const joiner = base.length > 0 && !base.endsWith("\n") ? "\n" : "";
  return base + joiner + targetTail + (targetTail.endsWith("\n") || targetTail === "" ? "" : "\n") + featureTail;
}
