import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordScaffoldWrite } from "./scaffold-writes.js";

// ---------------------------------------------------------------------------
// "Buildable from clean" scaffold — per-package-manager (#777, #783, #789)
// ---------------------------------------------------------------------------

/**
 * Native deps whose postinstall build step a strict package manager blocks by default until
 * approved. A scaffolded Vite/React/TS project pulls in esbuild (Vite's bundler); under pnpm
 * a missing approval fails `pnpm install` / `pnpm build` on a clean checkout with
 * `ERR_PNPM_IGNORED_BUILDS` (exit 1), and bun likewise refuses to run an untrusted package's
 * lifecycle scripts. Keep this list aligned with the board's own root package.json
 * `pnpm.onlyBuiltDependencies`. Used for BOTH pnpm `onlyBuiltDependencies` and bun
 * `trustedDependencies`.
 */
export const PNPM_BUILD_APPROVED_DEPS = ["esbuild", "@swc/core"];

/** Alias: the same approved native-build deps, named generically for non-pnpm callers. */
export const NATIVE_BUILD_APPROVED_DEPS = PNPM_BUILD_APPROVED_DEPS;

/**
 * A pnpm version that HONORS `pnpm.onlyBuiltDependencies`. The global pnpm 11.0.8 ignores
 * the approval config in package.json / pnpm-workspace.yaml / .npmrc entirely (still throws
 * ERR_PNPM_IGNORED_BUILDS on a clean install), so a scaffolded toy with no `packageManager`
 * pin runs under whatever global pnpm exists and fails. Pinning corepack to this version —
 * the same one the board itself uses — makes the approval take effect. (#783)
 */
export const PNPM_PACKAGE_MANAGER_PIN = "pnpm@10.12.1";

/**
 * `packageManager` corepack pins for the other Node managers (#789). A clean
 * `corepack <pm> install` resolves the project's lockfile under a deterministic manager
 * version instead of "whatever is global", which is what makes a fresh clone build the same
 * way the builder's worktree did. Versions chosen to match the lockfile formats the detector
 * already understands (yarn berry, the current npm/bun lines).
 */
export const PACKAGE_MANAGER_PINS: Record<"pnpm" | "npm" | "yarn" | "bun", string> = {
  pnpm: PNPM_PACKAGE_MANAGER_PIN,
  npm: "npm@10.9.2",
  yarn: "yarn@4.5.3",
  bun: "bun@1.1.38",
};

/** The literal placeholder a buggy scaffold once emitted — must NEVER appear in output. */
const PNPM_PLACEHOLDER_MARKER = "set this to true or false";

/** Which Node package manager a repo uses, inferred from lockfiles + existing manifest config. */
type NodePm = "pnpm" | "npm" | "yarn" | "bun";

interface PmDetection {
  /** The detected package manager. Defaults to "pnpm" for a bare package.json (the board's
   *  default, and what the original #777/#783 logic assumed). */
  pm: NodePm;
  /** True only when a concrete signal (explicit pin or a lockfile) identified the manager —
   *  the gate for PINNING `packageManager`. A bare package.json has `pinnable: false` so we
   *  don't stamp a manager onto a repo that hasn't chosen one (matches the #783 test). */
  pinnable: boolean;
}

function detectNodePmForApproval(repoPath: string, pkg: Record<string, unknown>): PmDetection {
  const pm = typeof pkg.packageManager === "string" ? (pkg.packageManager) : "";
  // An explicit packageManager pin is authoritative (it's already pinned, so pinnable is moot).
  if (pm.startsWith("pnpm@")) return { pm: "pnpm", pinnable: true };
  if (pm.startsWith("yarn@")) return { pm: "yarn", pinnable: true };
  if (pm.startsWith("bun@")) return { pm: "bun", pinnable: true };
  if (pm.startsWith("npm@")) return { pm: "npm", pinnable: true };
  // Otherwise infer from lockfiles / pnpm config.
  if (
    pkg.pnpm !== undefined ||
    existsSync(join(repoPath, "pnpm-lock.yaml")) ||
    existsSync(join(repoPath, "pnpm-workspace.yaml"))
  )
    return { pm: "pnpm", pinnable: true };
  if (existsSync(join(repoPath, "bun.lockb")) || existsSync(join(repoPath, "bun.lock")))
    return { pm: "bun", pinnable: true };
  if (existsSync(join(repoPath, "yarn.lock"))) return { pm: "yarn", pinnable: true };
  if (existsSync(join(repoPath, "package-lock.json"))) return { pm: "npm", pinnable: true };
  // Bare package.json, no lockfile yet: assume pnpm (the board default) for the build-script
  // approval, but DON'T pin a manager onto a repo that hasn't chosen one. `pinnable: false`
  // marks the manager as a GUESS — `ensureBuildableFromClean` will only act on it with
  // evidence that the approval is actually needed (#38).
  return { pm: "pnpm", pinnable: false };
}

/**
 * Dependency names a package.json declares directly, across every dependency field.
 */
function directDependencyNames(pkg: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const block = pkg[field];
    if (block && typeof block === "object" && !Array.isArray(block)) {
      for (const name of Object.keys(block as Record<string, unknown>)) names.add(name);
    }
  }
  return names;
}

/**
 * Does this project plausibly pull in a dep whose native build step needs approving?
 *
 * Checks the manifest's direct deps first, then falls back to an installed `node_modules`
 * probe — which catches the common TRANSITIVE case (a project lists `vite`, and esbuild
 * arrives underneath it). Deliberately no lockfile parsing: too heavy/format-specific for
 * a registration-time scaffold.
 *
 * Only consulted when the package manager itself was GUESSED (`pinnable: false`). For a
 * project with a real pnpm/bun signal the approval stays unconditional, so the #777/#783
 * `ERR_PNPM_IGNORED_BUILDS` protection is preserved exactly (a fresh clone of a pnpm repo
 * has no node_modules, and its manifest may only name `vite`).
 */
function needsNativeBuildApproval(repoPath: string, pkg: Record<string, unknown>): boolean {
  const direct = directDependencyNames(pkg);
  return NATIVE_BUILD_APPROVED_DEPS.some(
    (dep) => direct.has(dep) || existsSync(join(repoPath, "node_modules", ...dep.split("/"))),
  );
}

/**
 * Generalized "buildable from clean" scaffold (#789).
 *
 * Make a freshly-cloned project's build pass with NO manual approval prompts, whatever its
 * package manager:
 *  - **pnpm** — approve native build scripts (`pnpm.onlyBuiltDependencies`) + pin a pnpm version
 *    that honors them (#777/#783) + repair a broken `pnpm-workspace.yaml` placeholder.
 *  - **bun** — declare the same native deps as `trustedDependencies` (bun refuses untrusted
 *    postinstall scripts on a clean install) + pin `packageManager`.
 *  - **npm / yarn** — pin `packageManager` so the lockfile resolves under the right manager
 *    (npm/classic-yarn already run lifecycle scripts on a clean install, so no extra approval).
 *  - **cargo / go / python / java** — a clean clone builds without any approval gate; no-op.
 *
 * When NO manager signal exists (bare package.json, no lockfile) the manager is only a guess,
 * so nothing is written unless the project demonstrably needs the approval (#38) — otherwise a
 * plain npm repo ends up with a stray, uncommitted pnpm block that blocks every merge.
 *
 * Returns true if it changed any file (so callers can commit the repair). Clobber-safe,
 * idempotent, non-fatal. Never clobbers a deliberate `packageManager` choice the project
 * already made.
 */
export function ensureBuildableFromClean(repoPath: string): boolean {
  let changed = false;
  try {
    const pkgJsonPath = join(repoPath, "package.json");
    const wsPath = join(repoPath, "pnpm-workspace.yaml");
    const hasWorkspaceFile = existsSync(wsPath);
    let pm: NodePm = "pnpm";
    let approvalAllowed = false;

    if (existsSync(pkgJsonPath)) {
      const raw = readFileSync(pkgJsonPath, "utf8");
      let pkg: Record<string, unknown>;
      try {
        pkg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        pkg = {};
      }
      let pkgChanged = false;

      const detection = detectNodePmForApproval(repoPath, pkg);
      pm = detection.pm;
      const pinnable = detection.pinnable;

      // A guessed manager (bare package.json, no lockfile) is not licence to write that
      // manager's config into someone's project: registering a plain npm repo that depends on
      // neither approved dep used to leave a stray `pnpm.onlyBuiltDependencies` block behind,
      // uncommitted, which made the main checkout dirty from birth and blocked every merge
      // with `dirty_main` (#38). With no manager signal, only act on real evidence.
      approvalAllowed = pinnable || needsNativeBuildApproval(repoPath, pkg);

      // 1. Approve native build scripts under the strict managers that block them by default.
      if (!approvalAllowed) {
        // Nothing to approve, and no manager to pin — leave the project's package.json alone.
      } else if (pm === "pnpm") {
        // pnpm 10 no longer reads package.json's legacy `pnpm` field at all — it warns on
        // every command instead (#1040). When the repo already has a pnpm-workspace.yaml,
        // that is where the approval belongs; it is written there below, and package.json
        // is left alone. Only a repo with NO workspace file (a real pnpm project has no
        // other place for it) still gets the legacy field.
        if (!hasWorkspaceFile) {
          const pnpmCfg = (pkg.pnpm ?? {}) as Record<string, unknown>;
          if (mergeApprovedDeps(pnpmCfg, "onlyBuiltDependencies")) {
            pkg.pnpm = pnpmCfg;
            pkgChanged = true;
          }
        }
      } else if (pm === "bun") {
        // bun: `trustedDependencies` whitelists packages allowed to run lifecycle scripts.
        if (mergeApprovedDeps(pkg, "trustedDependencies")) pkgChanged = true;
      }
      // npm / yarn run lifecycle scripts on a clean install by default — nothing to approve.

      // 2. Pin a packageManager version so a clean clone resolves the lockfile deterministically
      //    (and, for pnpm, so the approval above is actually honored — #783). Only when the
      //    project has no packageManager yet (never clobber a deliberate choice) and we could
      //    identify the manager from a real signal — so we don't pin onto a bare package.json.
      if (pkg.packageManager === undefined && pinnable) {
        pkg.packageManager = PACKAGE_MANAGER_PINS[pm];
        pkgChanged = true;
      }

      if (pkgChanged) {
        const trailingNewline = raw.endsWith("\n") ? "\n" : "";
        writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + trailingNewline, "utf8");
        recordScaffoldWrite(repoPath, "package.json");
        changed = true;
      }
    } else if (hasWorkspaceFile) {
      // No package.json (unusual, but the workspace file alone is still a pnpm signal) —
      // detect straight off the workspace file's presence, same as detectNodePmForApproval.
      approvalAllowed = true;
    }

    // pnpm-workspace.yaml: repair a broken placeholder / bogus `allowBuilds:` block (not a
    // real pnpm key — the old repair left `allowBuilds: esbuild: true`, a silent no-op), and
    // — when pnpm approval is warranted and this repo already has a workspace file — ensure
    // `onlyBuiltDependencies` is declared there. Never written if it already lists every
    // approved dep (#1070: a fully-declared block must produce zero writes, or every
    // registration silently re-commits a no-op diff).
    if (hasWorkspaceFile) {
      const ws = readFileSync(wsPath, "utf8");
      let repaired = ws;
      if (repaired.includes(PNPM_PLACEHOLDER_MARKER) || /^\s*allowBuilds\s*:/m.test(repaired)) {
        repaired = repaired.replace(/^[ \t]*allowBuilds[ \t]*:[ \t]*\r?\n(?:[ \t]+\S.*\r?\n?)*/m, "");
      }
      if (pm === "pnpm" && approvalAllowed) {
        repaired = mergeApprovedDepsIntoWorkspaceYaml(repaired);
      }
      if (repaired !== ws) {
        writeFileSync(wsPath, repaired, "utf8");
        recordScaffoldWrite(repoPath, "pnpm-workspace.yaml");
        changed = true;
      }
    }
  } catch {
    /* non-fatal: scaffolding must never block registration */
  }
  return changed;
}

/**
 * Merge the approved native-build deps into `obj[key]` (an array of package names), preserving
 * any the project already declared and never duplicating. Returns true if the array changed.
 */
function mergeApprovedDeps(obj: Record<string, unknown>, key: string): boolean {
  const existing = Array.isArray(obj[key])
    ? (obj[key] as unknown[]).filter((d): d is string => typeof d === "string")
    : [];
  const merged = [...existing];
  for (const dep of PNPM_BUILD_APPROVED_DEPS) {
    if (!merged.includes(dep)) merged.push(dep);
  }
  if (merged.length === existing.length && existing.every((d, i) => d === merged[i])) return false;
  obj[key] = merged;
  return true;
}

/** Quote a YAML list item only when it needs it (e.g. a scoped package name starting with `@`,
 *  which is a reserved indicator character as the first character of a plain scalar). */
function yamlDepItem(dep: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(dep) ? dep : JSON.stringify(dep);
}

/**
 * Merge `PNPM_BUILD_APPROVED_DEPS` into pnpm-workspace.yaml's `onlyBuiltDependencies:` list,
 * preserving whatever the project already declared there (the workspace-file counterpart of
 * {@link mergeApprovedDeps}). Returns the text UNCHANGED if every approved dep is already
 * present — so a repo that already moved the approval here produces no write at all (#1070).
 */
function mergeApprovedDepsIntoWorkspaceYaml(ws: string): string {
  const blockRe = /^onlyBuiltDependencies:[ \t]*\r?\n((?:[ \t]+-[ \t]*.*\r?\n?)*)/m;
  const match = ws.match(blockRe);
  const existing = match
    ? Array.from(match[1].matchAll(/-\s*["']?([^"'\r\n]+?)["']?\s*$/gm)).map((m) => m[1].trim())
    : [];
  const merged = [...existing];
  for (const dep of PNPM_BUILD_APPROVED_DEPS) {
    if (!merged.includes(dep)) merged.push(dep);
  }
  if (match && merged.length === existing.length && existing.every((d, i) => d === merged[i])) {
    return ws;
  }
  const list = merged.map((d) => `  - ${yamlDepItem(d)}`).join("\n");
  const block = `onlyBuiltDependencies:\n${list}\n`;
  if (match && match.index !== undefined) {
    return ws.slice(0, match.index) + block + ws.slice(match.index + match[0].length);
  }
  return ws.replace(/\s*$/, "\n") + block;
}

/**
 * Backward-compatible alias for {@link ensureBuildableFromClean}.
 *
 * The original #777/#783 entry point was pnpm-only; #789 generalized it across package
 * managers. Kept so existing callers/tests that import `ensurePnpmBuildApproval` keep working —
 * behavior is identical for pnpm projects.
 */
export function ensurePnpmBuildApproval(repoPath: string): boolean {
  return ensureBuildableFromClean(repoPath);
}
