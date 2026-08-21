/**
 * Marker-file facts about a repo: which build/dependency files it has, and the one
 * derived fact (`uv`) that several stack decisions turn on (#521).
 *
 * Split out of `project-setup.service.ts` so the dependency runs one way. It used to be
 * the other way round — `stack-detector.service` imported `isUvProject` from
 * `project-setup.service`, which is exactly why `project-setup` could not call the
 * detector and grew its own copy of the detector's per-marker decisions instead. Pure
 * and synchronous: `fs` only, no DB, no LLM.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// The vocabulary lives in `shared` because `container-dep-volumes.ts` needs it too and a
// shared module cannot import from `server` — which is exactly how a second copy of this
// list grew there unnoticed (#695). This module stays the canonical DETECTOR; it is only
// the list of filenames that is shared.
import { PROJECT_MARKER_FILES } from "@agentic-kanban/shared/lib/stack-marker-files";

export function detectProjectMarkers(repoPath: string): string[] {
  try {
    const files = readdirSync(repoPath);
    return files.filter((f) => (PROJECT_MARKER_FILES as readonly string[]).includes(f));
  } catch {
    return [];
  }
}

/**
 * Is this Python repo managed by `uv`? (#120)
 *
 * uv installs into a project-local `.venv`, so pytest is NOT importable from the global
 * interpreter — a bare `python -m pytest` merge gate fails with "No module named pytest"
 * and blocks every merge. Detected from the `uv.lock` lockfile or a `[tool.uv]` section
 * in `pyproject.toml`; everything for a uv project must be prefixed with `uv run`.
 */
export function isUvProject(repoPath: string, markers: Set<string> | string[]): boolean {
  const set = markers instanceof Set ? markers : new Set(markers);
  if (set.has("uv.lock")) return true;
  if (!set.has("pyproject.toml")) return false;
  try {
    return /^\s*\[tool\.uv[.\]]/m.test(readFileSync(join(repoPath, "pyproject.toml"), "utf8"));
  } catch {
    return false;
  }
}
