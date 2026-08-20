/**
 * Project slugs for project-scoped URLs (#446).
 *
 * A slug is a stable, human-readable stand-in for a project id in the URL
 * (`/p/<slug>/<view>`). The mapping must be DETERMINISTIC and collision-free:
 * a project's URL may never change just because ANOTHER project was added or
 * renamed, so when several names slugify to the same string, *every* colliding
 * entry is disambiguated — never only the later ones.
 */

/** The minimum a project must expose to take part in slug resolution. */
import { slugify } from "@agentic-kanban/shared/lib/slugify";
export interface SlugProject {
  id: string;
  name: string;
}

/** Maximum length of the readable part of a slug. */
const MAX_SLUG_LENGTH = 48;

/** Number of id characters appended when disambiguating a collision. */
const DISAMBIGUATION_ID_LENGTH = 6;

const FALLBACK_SLUG = "project";

/**
 * Lowercase, strip diacritics, collapse every run of non-alphanumerics to a
 * single `-`, trim leading/trailing `-`, and cap the length. Never returns an
 * empty string — a name with no usable characters slugifies to `"project"`.
 */
export function slugifyProjectName(name: string): string {
  return slugify(name, { maxLength: MAX_SLUG_LENGTH, fallback: FALLBACK_SLUG });
}

/**
 * Build the `projectId -> slug` map for a set of projects.
 *
 * Collision rule: if two or more projects share a base slug, EVERY one of them
 * gets `<base>-<first 6 chars of its id>`. If that still collides, the project
 * falls back to its raw id as the slug (ids are unique, so this terminates).
 *
 * The result depends only on the SET of projects, not on the array order.
 */
export function buildProjectSlugMap(projects: SlugProject[]): Map<string, string> {
  const baseSlugs = new Map<string, string>();
  const baseCounts = new Map<string, number>();

  for (const project of projects) {
    if (!project || typeof project.id !== "string" || project.id.length === 0) continue;
    if (baseSlugs.has(project.id)) continue; // duplicate id — first entry wins
    const base = slugifyProjectName(project.name ?? "");
    baseSlugs.set(project.id, base);
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }

  // Pass 2: disambiguate every member of a colliding base group.
  const candidates = new Map<string, string>();
  const candidateCounts = new Map<string, number>();
  for (const [id, base] of baseSlugs) {
    const candidate =
      (baseCounts.get(base) ?? 0) > 1
        ? `${base}-${id.slice(0, DISAMBIGUATION_ID_LENGTH).toLowerCase()}`
        : base;
    candidates.set(id, candidate);
    candidateCounts.set(candidate, (candidateCounts.get(candidate) ?? 0) + 1);
  }

  // Pass 3: anything still colliding falls back to the full (unique) id.
  const result = new Map<string, string>();
  for (const [id, candidate] of candidates) {
    result.set(id, (candidateCounts.get(candidate) ?? 0) > 1 ? id.toLowerCase() : candidate);
  }
  return result;
}

/**
 * Resolve a `/p/<slugOrId>` segment to a project id.
 *
 * Accepts either a slug (case-insensitive) or a raw project id, so an
 * id-based link keeps working forever even if the project is renamed.
 * Returns null when nothing matches.
 */
export function resolveProjectIdFromSlug(
  slugOrId: string,
  projects: SlugProject[],
): string | null {
  if (!slugOrId) return null;
  const needle = slugOrId.toLowerCase();

  // Raw id wins — it can never rot.
  for (const project of projects) {
    if (project?.id && project.id.toLowerCase() === needle) return project.id;
  }

  for (const [id, slug] of buildProjectSlugMap(projects)) {
    if (slug === needle) return id;
  }
  return null;
}
