/**
 * ONE slug rule (#565).
 *
 * `lowercase → collapse non-alphanumeric runs to "-" → trim dashes → cap length` was
 * hand-written nine times across server, shared and client, and had drifted: some capped at
 * 32, some at 40, 60, 80, some not at all; some trimmed the input first, some folded
 * diacritics, some produced a trailing "-" when the cap landed mid-run. The same ticket title
 * therefore slugified differently in a branch name, a project URL and an export filename.
 *
 * Diacritic folding is in the BASE rule, not an option: without it "Übersicht" and "bersicht"
 * both had to be dealt with per site, and the client's project-URL slugger was the only place
 * that got it right. `ß` becomes `ss` before the NFD pass because it has no combining-mark
 * decomposition.
 *
 * Where a site's rule genuinely differs it keeps a NAMED wrapper next to it saying why —
 * git-safe branch names must keep `/` and `_` (`sanitizeBranchName`), markdown anchors must
 * match GitHub's algorithm (`slugifyHeading`). Those are not this function.
 *
 * Pure — no node builtins, no drizzle — so the client uses the same implementation.
 */

export interface SlugifyOptions {
  /** Cap on the slug's length. Trailing dashes left by the cut are trimmed after slicing. */
  maxLength?: number;
  /** Returned when the input has no usable characters. Default "" — pass one when the caller needs a non-empty id. */
  fallback?: string;
}

export function slugify(input: string | null | undefined, opts: SlugifyOptions = {}): string {
  const slug = (input ?? "")
    // No combining-mark decomposition of its own, so it must be spelled out before NFD.
    .replace(/ß/g, "ss")
    .normalize("NFD")
    // Combining diacritical marks — drop them, keeping the base letter.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, opts.maxLength ?? Infinity)
    // The slice can land inside a run and leave a dangling "-".
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : (opts.fallback ?? "");
}
