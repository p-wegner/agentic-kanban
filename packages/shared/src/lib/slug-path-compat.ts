import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Locating artifacts whose on-disk path was produced by the PRE-#565 slug rules (#682).
 *
 * `b329b80ddd` consolidated nine slug implementations into one — a genuine improvement — but two
 * of the collapsed sites derive PERSISTED paths, and the new rule moves them:
 *
 *   `docs/board-runs/<projectSlug(name)>.md`            (drive retro, accumulated history)
 *   `specs/<issueNumber>-<issueSlug(title)>/<file>`     (phase artifacts)
 *
 * Measured divergences: `"Über-Ticket"` → `ber-ticket` (old) vs `uber-ticket` (new); `"Straße"`
 * → `stra-e` vs `strasse`. It is not only diacritics — the old rule did not re-trim a dash left
 * behind when the length cap landed mid-run, so a capped ASCII slug moves too (`…uvw-` → `…uvw`).
 *
 * This board is used with German titles, so the effect was concrete: a project with an umlaut
 * silently starts a SECOND retro file and its accumulated history stays in the first one. The
 * consolidation commit framed diacritic folding as a pure improvement and never stated it was a
 * data-compat break; there was no migration, no test and no note.
 *
 * The fix is a one-time adopt-on-write rather than a permanent dual read: if the new path does
 * not exist and the legacy one does, RENAME the legacy artifact onto the new path. History
 * follows the rule change once and then the legacy spelling is gone — the alternative, reading
 * both forever, keeps two truths alive and has to be re-decided at every new call site.
 */

/**
 * The slug rule as it stood BEFORE #565: lowercase, collapse non-alphanumeric runs, trim
 * dashes, cap — with NO `ß`→`ss`, NO combining-mark folding, and NO re-trim after the cap.
 *
 * Deliberately a separate function from `slugify` rather than an option on it: this is not a
 * spelling anyone should choose for new data, only one that has to be recognised in old data.
 */
export function legacySlugify(input: string | null | undefined, opts: { maxLength?: number; fallback?: string } = {}): string {
  const slug = (input ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, opts.maxLength ?? Infinity);
  return slug.length > 0 ? slug : (opts.fallback ?? "");
}

export interface AdoptLegacySlugPathResult {
  /** True when a legacy artifact was renamed onto the current path. */
  adopted: boolean;
  /** The legacy path that was adopted, for logging. */
  from?: string;
}

/**
 * If `currentPath` does not exist but `legacyPath` does, move the legacy artifact to the current
 * path so the accumulated content keeps being appended to instead of being orphaned.
 *
 * Best-effort by construction: this runs immediately before a write that would otherwise create
 * a fresh file, so a failure here must degrade to "write the new file" rather than fail the
 * caller. Identical paths (the common case — an ASCII name whose slug did not change) are a
 * cheap no-op with no filesystem calls beyond the existence checks.
 */
export function adoptLegacySlugPath(
  currentPath: string,
  legacyPath: string,
  deps: { exists?: (p: string) => boolean; rename?: (from: string, to: string) => void } = {},
): AdoptLegacySlugPathResult {
  if (currentPath === legacyPath) return { adopted: false };
  const exists = deps.exists ?? existsSync;
  if (exists(currentPath) || !exists(legacyPath)) return { adopted: false };
  const rename = deps.rename ?? renameSync;
  try {
    rename(legacyPath, currentPath);
    return { adopted: true, from: legacyPath };
  } catch {
    // The write that follows will simply create the new path. Losing the adoption is a worse
    // outcome than a crash only if it is silent — the callers log it.
    return { adopted: false };
  }
}

/** Convenience for a `<dir>/<name><ext>` artifact whose NAME is the slug. */
export function legacySiblingPath(currentPath: string, legacyName: string, ext = ""): string {
  return join(dirname(currentPath), `${legacyName}${ext}`);
}
