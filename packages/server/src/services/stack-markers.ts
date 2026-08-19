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

const PROJECT_MARKER_FILES = [
  "package.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock",
  "Cargo.toml", "go.mod", "requirements.txt", "Pipfile", "pyproject.toml", "uv.lock",
  "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "mix.exs",
  "composer.json", "composer.lock",
  "Makefile", "justfile", "Taskfile.yml",
];

export function detectProjectMarkers(repoPath: string): string[] {
  try {
    const files = readdirSync(repoPath);
    return files.filter(f => PROJECT_MARKER_FILES.includes(f));
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
