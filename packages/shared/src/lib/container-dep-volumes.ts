import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { discoverWorkspaceNodeModules, parseSymlinkDirs } from "./worktree-symlink-bootstrap.js";

/**
 * Dependency directories for a CONTAINERIZED builder, backed by named volumes (#138).
 *
 * Why not just use the bind-mounted worktree, as the host builder does:
 *
 *  - Correctness. On Docker Desktop for Windows the worktree reaches the container
 *    over a 9p/virtiofs bind mount. pnpm's cold install is rename-heavy, and a
 *    just-created path is briefly unavailable across that layer, so the FIRST
 *    install in a fresh worktree dies with `ERR_PNPM_EACCES ... rename` and then
 *    succeeds on retry. That shape — fails once per fresh worktree, invisible on
 *    re-run — is the worst kind of flake.
 *  - Speed. Every dependency file read pays a round trip. Measured on the taskflow
 *    fixture: `collect 408s` / `prepare 219s` against an 86s suite.
 *  - Isolation. A host-built `node_modules` (native binaries compiled for Windows)
 *    is otherwise visible inside the Linux container. That leak was the root cause
 *    of #135.
 *
 * A container-managed volume has Linux-native filesystem semantics, no host round
 * trip, and shadows whatever the host has at that path — fixing all three at once.
 */

/** A dependency directory relocated onto a named volume. */
export interface DependencyVolume {
  /** Docker volume name. Deterministic, so re-provisioning REUSES the warm volume. */
  name: string;
  /** Path relative to the worktree root, POSIX-separated, e.g. "packages/server/node_modules". */
  relPath: string;
  /** Absolute path inside the container. */
  containerPath: string;
}

/** Volume names are prefix-scoped so teardown can never match a co-tenant's volume. */
export const DEP_VOLUME_PREFIX = "agentic-kanban-deps";

/**
 * Directory names that hold installed dependencies, by ecosystem marker.
 *
 * Only directories that live INSIDE the worktree qualify. Go's module cache and
 * Gradle's caches live in GOPATH / GRADLE_USER_HOME outside the tree, so those
 * stacks get no volume here (and need none — they never hit the rename flake).
 */
const MARKER_DEP_DIRS: ReadonlyArray<{ marker: string; dirs: string[] }> = [
  { marker: "package.json", dirs: ["node_modules"] },
  { marker: "Cargo.toml", dirs: ["target"] },
  { marker: "pyproject.toml", dirs: [".venv"] },
  { marker: "requirements.txt", dirs: [".venv"] },
  { marker: "Pipfile", dirs: [".venv"] },
];

/**
 * The dependency directories to relocate for a worktree, as worktree-relative
 * POSIX paths.
 *
 * Precedence:
 *  1. The project's configured `symlinkDirs` — an explicit statement of "these are
 *     this project's dependency directories", already validated for traversal.
 *  2. Otherwise, ecosystem markers on disk.
 *
 * Either way, a Node workspace monorepo is expanded: under a strict linker the
 * root `node_modules` does not hold the packages' dependencies — each workspace
 * package has its own. Relocating only the root would leave the per-package
 * directories (the bulk of the files) on the bind mount, fixing neither symptom.
 */
export function deriveDependencyDirs(opts: {
  worktreePath: string;
  /**
   * The project's `symlink_dirs` — either the raw JSON column or an
   * already-parsed list, since the two call sites hold it in different shapes.
   */
  symlinkDirs?: string | string[] | null;
}): string[] {
  const { worktreePath, symlinkDirs } = opts;

  const configured = Array.isArray(symlinkDirs)
    ? symlinkDirs.filter((dir) => typeof dir === "string" && dir.length > 0)
    : parseSymlinkDirs(symlinkDirs);
  const base =
    configured.length > 0
      ? configured
      : MARKER_DEP_DIRS.filter((entry) => existsSync(join(worktreePath, entry.marker))).flatMap(
          (entry) => entry.dirs,
        );

  const dirs = new Set(base);

  // Expand a Node workspace monorepo into its per-package node_modules.
  if (dirs.has("node_modules")) {
    for (const rel of discoverWorkspaceNodeModules(worktreePath)) {
      dirs.add(rel.replace(/\\/g, "/"));
    }
  }

  return [...dirs].sort();
}

/**
 * Deterministic volume name for a workspace's dependency directory.
 *
 * Deterministic matters: `devcontainer up` is idempotent and runs from two
 * independent call sites (workspace create and session launch), so the second one
 * must attach the SAME volume rather than provision an empty one and discard a
 * warm install.
 *
 * The workspace id is the scope — dependency trees must not be shared between
 * branches, which is exactly the drift the symlink model suffered from.
 */
export function dependencyVolumeName(workspaceId: string, relPath: string): string {
  const slug = relPath.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${DEP_VOLUME_PREFIX}-${workspaceId}-${slug}`;
}

/** Volume-name prefix matching every dependency volume of one workspace. */
export function workspaceVolumePrefix(workspaceId: string): string {
  return `${DEP_VOLUME_PREFIX}-${workspaceId}-`;
}

export function buildDependencyVolumes(
  workspaceId: string,
  relDirs: string[],
  remoteWorkspaceFolder: string,
): DependencyVolume[] {
  const root = remoteWorkspaceFolder.replace(/\/+$/, "");
  return relDirs.map((relPath) => ({
    name: dependencyVolumeName(workspaceId, relPath),
    relPath,
    containerPath: `${root}/${relPath}`,
  }));
}

/**
 * Compare two HOST paths the way the platform's filesystem does.
 *
 * Needed to match the devcontainer CLI's `devcontainer.local_folder` label, which
 * carries the host path AFTER the CLI has normalized it — on Windows lowercased
 * and backslash-separated, so a board-supplied `C:/projects/app` is stored as
 * `c:\projects\app`. Matching those with docker's exact `--filter label=<path>`
 * finds nothing, so teardown removes no container, and the dependency volumes
 * then fail to delete with "volume is in use": a silent, total leak.
 */
export function sameHostPath(a: string, b: string): boolean {
  const normalize = (p: string) =>
    process.platform === "win32"
      ? p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()
      : p.replace(/\/+$/, "");
  return normalize(a) === normalize(b);
}

/**
 * Predict the container-side workspace folder BEFORE `devcontainer up` runs.
 *
 * Volume mounts must be passed INTO `up`, but the CLI only reports the real
 * `remoteWorkspaceFolder` afterwards — the same chicken-and-egg the profile mount
 * has. The devcontainer spec's default is `/workspaces/<basename>`; a config may
 * override it with `workspaceFolder`. Callers verify the prediction against the
 * handle afterwards and warn on a mismatch rather than silently mounting volumes
 * at paths that are not in the worktree.
 */
export function predictRemoteWorkspaceFolder(worktreePath: string): string {
  const configured = readDevcontainerWorkspaceFolder(worktreePath);
  if (configured) return configured;
  return `/workspaces/${basename(worktreePath)}`;
}

function readDevcontainerWorkspaceFolder(worktreePath: string): string | undefined {
  for (const rel of [join(".devcontainer", "devcontainer.json"), ".devcontainer.json"]) {
    const path = join(worktreePath, rel);
    if (!existsSync(path)) continue;
    try {
      const parsed = parseJsonc(readFileSync(path, "utf8"));
      const folder = (parsed as Record<string, unknown> | null)?.workspaceFolder;
      if (typeof folder === "string" && folder.trim()) return folder.trim();
    } catch {
      /* unparseable config — fall back to the spec default */
    }
    return undefined;
  }
  return undefined;
}

/**
 * devcontainer.json is JSONC: line/block comments and trailing commas are legal.
 * `JSON.parse` rejects all three, so strip them first. String-aware, so a `//`
 * inside a value (e.g. a URL) survives.
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        // Copy the escaped character verbatim so an escaped quote does not
        // terminate the string.
        if (next !== undefined) {
          out += next;
          i++;
        }
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }

  // Trailing commas before a closing brace/bracket.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
