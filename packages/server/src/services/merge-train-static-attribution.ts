/**
 * Static-tier attribution (#1769): the guard suites (nloc ratchet, openapi drift, env-read
 * ownership) name the offending FILE in their output but no failing SUITE, so the train used to
 * call the red unattributable, spawn a fix agent on the whole assembled tree and let the breaker
 * pause the project. Here the named file is mapped to the members whose changed files touch it.
 *
 * Pure: text and members in, owners out. A file nobody touched (or one every member touched)
 * attributes nothing — that is a true interaction and stays the fix agent's / bisect's.
 */
import type { TrainMember } from "./merge-train-assembly.js";

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

const SOURCE_FILE = /([A-Za-z0-9_@./\\-]+\.(?:ts|tsx|mts|mjs|cjs|js))(?=::|\b)/g;

/** Source files named in guard output (`path/to/file.ts::symbol`, `file.ts: 418`). */
export function extractGuardNamedFiles(message: string): string[] {
  const files = new Set<string>();
  for (const m of message.matchAll(SOURCE_FILE)) {
    const f = normalizePath(m[1]);
    if (f.includes("/") || /::/.test(message.slice(m.index! + m[1].length, m.index! + m[1].length + 2))) files.add(f);
  }
  return [...files];
}

/** Route-name hints from an openapi-drift message: `/api/plugins/{id}/...` -> plugins, "the workers routes" -> workers. */
export function extractOpenApiRouteHints(message: string): string[] {
  if (!/openapi/i.test(message)) return [];
  const hints = new Set<string>();
  for (const m of message.matchAll(/\/api\/([a-z][a-z0-9-]*)/gi)) hints.add(m[1].toLowerCase());
  for (const m of message.matchAll(/\b([a-z][a-z0-9-]*)\s+routes?\b/gi)) hints.add(m[1].toLowerCase());
  hints.delete("the");
  return [...hints];
}

function touches(changed: string, wanted: string): boolean {
  return changed === wanted || changed.endsWith(`/${wanted}`);
}

/** Changed files (repo-relative) per member that the guard text points at. */
export function attributeStaticTierFailure<M extends TrainMember>(
  message: string,
  members: readonly M[],
): { owners: M[]; innocent: M[]; files: string[] } | null {
  if (members.length < 2) return null;
  const named = extractGuardNamedFiles(message);
  const hints = extractOpenApiRouteHints(message);
  if (named.length === 0 && hints.length === 0) return null;
  const files = new Set<string>();
  const owners = members.filter((m) => {
    let hit = false;
    for (const raw of m.changedFiles ?? []) {
      const c = normalizePath(raw);
      const byName = named.some((n) => touches(c, n));
      const byRoute = hints.some((h) => new RegExp(`(^|/)routes/[^/]*${h.replace(/[^a-z0-9-]/g, "")}[^/]*\\.ts$`).test(c));
      if (byName || byRoute) { files.add(c); hit = true; }
    }
    return hit;
  });
  if (owners.length === 0 || owners.length === members.length) return null;
  const ids = new Set(owners.map((o) => o.workspaceId));
  return { owners, innocent: members.filter((m) => !ids.has(m.workspaceId)), files: [...files] };
}
