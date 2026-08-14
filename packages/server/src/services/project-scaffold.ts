import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db, type Database } from "../db/index.js";
import { getBoardNavigatorSkillId } from "../repositories/project-scaffold.repository.js";
import { ensureBuildableFromClean } from "./project-scaffold/buildable-from-clean.js";

/**
 * New-project scaffold: the small, project-agnostic, clobber-safe pieces the board writes when a
 * project is created or an existing repo is imported, so a fresh project is hands-off-ready.
 *
 * Deliberately GENERIC — only translate the *ideas* the board relies on; never embed
 * board-specific entries (kanban.db, agentic-kanban paths). Heavier constructs (hook delivery,
 * a verify-gate runner, objective.md, bundling skills into repos) are tracked as separate tickets.
 *
 * FACADE (god-module gate, #875/#888/#889): the single-file version grew past the 1000-line
 * hard ceiling, so it was split by responsibility into ./project-scaffold/* and re-exported
 * here — see stack-profile.service.ts / agent-stream-parser.ts for the same pattern. The PUBLIC
 * export surface is byte-identical, so the existing importers (project-registration.ts,
 * project.service.ts, cli/commands/*, startup/exit-workflow.ts, stack-profile/persistence.ts,
 * tests) are unchanged.
 *
 * The hook-scaffold / verify-gate helpers below stay in this module ON PURPOSE: `resolveHookSource`
 * anchors on `import.meta.url` (this file's directory) to locate the shipped hook sources, so
 * moving them into a subdirectory would silently shift every packaged/dev lookup path by one level.
 */

// --- .gitignore scaffold (generic agent artifacts + per-stack build output, #811) ---
export {
  GENERIC_AGENT_GITIGNORE,
  STACK_BUILD_ARTIFACT_GITIGNORE,
  stackBuildArtifactGitignore,
  ensureAgentGitignore,
} from "./project-scaffold/gitignore.js";

// --- Starter onboarding docs (CLAUDE.md / AGENTS.md) ---
export {
  STARTER_CLAUDE_MD,
  ensureStarterClaudeMd,
  STARTER_AGENTS_MD,
  ensureStarterAgentsMd,
} from "./project-scaffold/starter-docs.js";

// --- "Buildable from clean" scaffold — per-package-manager (#777, #783, #789) ---
export {
  PNPM_BUILD_APPROVED_DEPS,
  NATIVE_BUILD_APPROVED_DEPS,
  PNPM_PACKAGE_MANAGER_PIN,
  PACKAGE_MANAGER_PINS,
  ensureBuildableFromClean,
  ensurePnpmBuildApproval,
} from "./project-scaffold/buildable-from-clean.js";

// --- Scaffold-write record (#38, #41) + the commit that consumes it ---
// `recordScaffoldArtifactWrite` (producer) and `commitProjectScaffoldArtifacts` (consumer) share
// ONE module-level record, owned by ./project-scaffold/scaffold-writes.js and imported by both —
// never duplicated, or a write recorded by one side is invisible to the other (#38 dirty-main).
export { recordScaffoldArtifactWrite } from "./project-scaffold/scaffold-writes.js";
export { commitProjectScaffoldArtifacts } from "./project-scaffold/commit.js";

// ---------------------------------------------------------------------------
// Hook scaffold
// ---------------------------------------------------------------------------

export interface HookScaffoldOptions {
  /** Files that must never be destroyed (relative to repoPath or absolute). */
  vitalFiles?: string[];
  /**
   * Include the cross-worktree write guard. Defaults to true unconditionally — the
   * guard is a runtime no-op while the repo has a single worktree (see
   * prevent-cross-worktree-writes.js), so shipping it before any worktree exists is
   * harmless and is what makes it present once the first worktree IS created (#216:
   * gating this on `repoHasWorktrees` at scaffold time meant the guard was never
   * written for a freshly registered project, since no worktree exists yet). Pass
   * `false` explicitly to opt out.
   */
  includeWorktreeGuard?: boolean;
}

// Module directory — used to locate the hook sources shipped with the package.
// Bundled (dist/server.js): _moduleDir = dist/, hooks live in dist/scaffold/hooks/
// (copied there by scripts/copy-assets.mjs and shipped via package.json "files").
// Dev (src/services/): the packaged dir doesn't exist; fall back to src/scaffold/
// (the canonical tested copies of ALL scaffold hooks — #990) and then the repo-root
// .claude/hooks/ walk-up (the dev checkout's live hooks).
const _moduleDir = dirname(fileURLToPath(import.meta.url));

function resolveHookSource(filename: string): string | null {
  // 1. Packaged copy — the robust path for npm/npx installs (dist/scaffold/hooks/,
  //    shipped in the tarball). Before this existed, npx installs shipped NO hook
  //    sources and every scaffold hook (vital-file-guard, cross-worktree guard,
  //    smart-hooks runner, verify-gate runner) silently vanished from published
  //    installs (#952). Two relative candidates because the bundles sit at
  //    different depths: dist/server.js|mcp.js (_moduleDir = dist/) and
  //    dist/cli/index.js (_moduleDir = dist/cli/).
  // 2. Dev: the canonical tested sources next to this module (src/services/ →
  //    src/scaffold/) — all scaffold hooks live there (#990); the repo-root
  //    .claude/hooks/ copies are the checkout's live deployments of the same
  //    sources, kept byte-identical by the identity tests.
  const packagedCandidates = [
    join(_moduleDir, "scaffold", "hooks", filename),
    join(_moduleDir, "..", "scaffold", "hooks", filename),
    join(_moduleDir, "..", "scaffold", filename),
  ];
  for (const candidate of packagedCandidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch { /* try next */ }
  }

  // 3. Dev fallback: walk up from the module dir to the git repo root, where the
  //    dev checkout's live .claude/hooks dir holds the remaining hook sources.
  let dir = _moduleDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".claude", "hooks", filename);
    try {
      return readFileSync(candidate, "utf8");
    } catch { /* try parent */ }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // Loud failure: the packaged copy should always exist in a published install and
  // one of the dev paths always exists in a checkout — reaching here is a bug
  // (broken build/pack), never a normal condition. Never skip silently.
  console.warn(
    `[scaffold] Hook source not found: ${filename}. Looked in the packaged dist/scaffold/hooks/, ` +
      `src/scaffold/, and repo .claude/hooks/. The scaffolded project will be missing this quality ` +
      `gate — this indicates a broken build or npm pack (see #952).`,
  );
  return null;
}

/** Content of the generic vital-file-guard hook — read once on first call. */
let _vitalGuardSource: string | null | undefined = undefined;
function getVitalGuardSource(): string | null {
  if (_vitalGuardSource === undefined) _vitalGuardSource = resolveHookSource("vital-file-guard.js");
  return _vitalGuardSource;
}

let _worktreeGuardSource: string | null | undefined = undefined;
function getWorktreeGuardSource(): string | null {
  if (_worktreeGuardSource === undefined) _worktreeGuardSource = resolveHookSource("prevent-cross-worktree-writes.js");
  return _worktreeGuardSource;
}

let _smartRunnerSource: string | null | undefined = undefined;
function getSmartRunnerSource(): string | null {
  if (_smartRunnerSource === undefined) _smartRunnerSource = resolveHookSource("smart-hooks-runner.js");
  return _smartRunnerSource;
}

/**
 * `git-topology-cache.js` — a hard dependency of `smart-hooks-runner.js` (#392/#279).
 *
 * The runner `require`s it at TOP LEVEL to memoize `git rev-parse --show-toplevel` /
 * `--git-common-dir` across invocations (each hook call is a fresh process, and those spawns cost
 * 1.9s/4.0s on a loaded Windows box). Shipping the runner without it makes every hook call in a
 * scaffolded project throw MODULE_NOT_FOUND — so these two files must always be written together.
 */
let _topologyCacheSource: string | null | undefined = undefined;
function getTopologyCacheSource(): string | null {
  if (_topologyCacheSource === undefined) _topologyCacheSource = resolveHookSource("git-topology-cache.js");
  return _topologyCacheSource;
}

const HOOKS_README = `# .claude/hooks — Agent Safety Guards

Auto-generated by agentic-kanban on project registration. Edit freely.

## vital-file-guard.js

Blocks any shell command that could destroy a declared vital project file (deletion,
overwrite, truncation). Before blocking it creates a timestamped backup so data is
never silently lost.

### Declare vital files

Two ways (merged at runtime):

1. **\`vital-files.json\`** (this directory) — a JSON array of file paths relative to
   the repo root:
   \`\`\`json
   ["data/app.db", "config/secrets.yaml"]
   \`\`\`

2. **\`VITAL_FILES\` env var** — colon-separated paths (useful in CI / per-machine
   overrides without touching the repo).

### Bypass

Set \`ALLOW_VITAL_DESTROY=1\` in your environment. The agent must NOT set this itself;
it exists for a human to authorize a genuine reset. A backup is taken either way.

## prevent-cross-worktree-writes.js

When this repo uses git worktrees, this hook prevents an agent running in one worktree
from writing into another worktree of the same repo. It is wired unconditionally — it
no-ops at runtime while the repo has a single worktree, so it is already in place by the
time the first workspace worktree is created.

### Bypass

Set \`ALLOW_CROSS_WORKTREE_WRITE=1\`.

## smart-hooks-runner.js + smart-hooks-rules.json

The runner gives your builder incremental edit-time feedback: after each Write/Edit it runs
the quick check for the file's stack (typecheck / quick tests), and again on Stop. It is wired
in \`.claude/settings.json\` (PostToolUse + Stop) and is **project-agnostic** — every command
comes from the rules file, nothing is hard-coded.

\`../smart-hooks-rules.json\` (in \`.claude/\`, **machine-generated** — do not hand-edit) maps
source-file patterns to those commands. The board regenerates it from the project's detected
stack profile whenever the profile changes. To refresh it, re-detect the stack profile
(Project Settings -> Stack Profile, or \`GET /api/projects/:id/stack-profile?refresh=true\`).

## smart-hooks-config.json

Optional hand-authored hooks for the runner (PreToolUse / Stop entries), merged with the
generated rules. Currently empty — add entries here for project-specific checks the generated
rules don't cover.

## settings.json entries

Hook entries were **appended** to \`.claude/settings.json\` (never overwritten). The
vital-file guard runs on every Bash/PowerShell command; the worktree guard (if present)
runs on every structured file-write tool.
`;

const EMPTY_SMART_HOOKS_CONFIG = JSON.stringify(
  {
    version: "1.0.0",
    hooks: {
      PreToolUse: [],
      Stop: [],
    },
  },
  null,
  2
) + "\n";

/**
 * Merge a hooks array from the scaffold into an existing .claude/settings.json without
 * overwriting anything. Existing hooks with the same command string are skipped (idempotent).
 */
function mergeSettingsHooks(
  settingsPath: string,
  newEntries: { event: string; matcher?: string; command: string }[]
): void {
  let settings: Record<string, unknown> = {};
  try {
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    }
  } catch { /* start fresh */ }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  settings.hooks = hooks;

  for (const entry of newEntries) {
    const { event, matcher, command } = entry;
    if (!Array.isArray(hooks[event])) hooks[event] = [];
    const arr = hooks[event] as Record<string, unknown>[];

    // Build the new hook entry
    const hookObj: Record<string, unknown> = { type: "command", command };
    const wrapperEntry: Record<string, unknown> = matcher
      ? { matcher, hooks: [hookObj] }
      : { hooks: [hookObj] };

    // Skip if this exact command is already wired for this event UNDER THE SAME MATCHER.
    // Keying on the command alone was a silent wiring bug (#369): one script legitimately
    // needs two matchers (the worktree guard runs on Write|Edit|… *and* on Bash|PowerShell),
    // and command-only dedupe dropped the second one without a word — leaving the shell
    // vector uncovered while the settings file looked like the guard was installed.
    const alreadyPresent = arr.some((e) => {
      if ((e.matcher ?? undefined) !== matcher) return false;
      const innerHooks = (e.hooks as Record<string, unknown>[] | undefined) ?? [];
      return innerHooks.some((h) => h.command === command);
    });
    if (alreadyPresent) continue;

    arr.push(wrapperEntry);
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

/**
 * Scaffold a minimal set of generic Claude Code hooks into a target repo.
 *
 * Written on every project registration / import. Clobber-safe: existing files
 * are never overwritten; existing settings.json hook arrays are only appended to.
 * Non-fatal on any error — scaffolding must never block registration.
 *
 * What it writes:
 *   .claude/hooks/vital-file-guard.js     — parameterized vital-file destruction guard
 *   .claude/hooks/vital-files.json        — empty by default (populated via vitalFiles option)
 *   .claude/hooks/prevent-cross-worktree-writes.js  — always (opt out via includeWorktreeGuard: false)
 *   .claude/hooks/smart-hooks-config.json — empty runner config
 *   .claude/hooks/README.md               — explains the hooks
 *   .claude/settings.json                 — hook entries appended (never overwritten)
 */

/**
 * Write a board-owned hook script, REFRESHING an out-of-date copy (#472).
 *
 * These files were written once and never again (`if (!existsSync(...))`), so every fix to a
 * guard reached only NEWLY registered projects. That is how the #472 cross-worktree hole would
 * have survived in `eventhub-backend` indefinitely: the guard was present and correctly wired
 * there, just built before the fix existed. It is the same distribution defect as #392, one
 * level up — there the scaffold source had drifted from the deployed copy; here the deployed
 * copy can never catch up.
 *
 * The shipped sources carry `// @board-hook-version: N`. A copy with a lower version (or none,
 * i.e. predating this mechanism) is replaced; an equal or higher one is left alone, so this is
 * idempotent and cannot downgrade a project that is somehow ahead.
 *
 * These are BOARD-OWNED artifacts, not user files — CLAUDE.md already forbids weakening or
 * routing around them, so a local edit is not a state worth preserving. Bumping the version in
 * the source is what ships a fix to every project.
 */
function boardHookVersion(source: string): number {
  const match = /^\/\/ @board-hook-version: (\d+)/m.exec(source);
  return match ? Number(match[1]) : 0;
}

function writeBoardHookIfOutdated(targetPath: string, source: string | null): void {
  if (!source) return;
  if (existsSync(targetPath)) {
    let current = "";
    try {
      current = readFileSync(targetPath, "utf8");
    } catch {
      return; // unreadable — leave it alone rather than clobber something we cannot inspect
    }
    if (boardHookVersion(current) >= boardHookVersion(source)) return;
    console.log(
      `[scaffold] refreshing ${targetPath} (v${boardHookVersion(current)} -> v${boardHookVersion(source)})`,
    );
  }
  writeFileSync(targetPath, source, "utf8");
}

export function ensureHookScaffold(repoPath: string, options: HookScaffoldOptions = {}): void {
  try {
    const hooksDir = join(repoPath, ".claude", "hooks");
    mkdirSync(hooksDir, { recursive: true });

    // --- vital-file-guard.js ---
    const vitalGuardPath = join(hooksDir, "vital-file-guard.js");
    writeBoardHookIfOutdated(vitalGuardPath, getVitalGuardSource());

    // --- vital-files.json ---
    const vitalFilesPath = join(hooksDir, "vital-files.json");
    if (!existsSync(vitalFilesPath)) {
      const list = options.vitalFiles ?? [];
      writeFileSync(vitalFilesPath, JSON.stringify(list, null, 2) + "\n", "utf8");
    }

    // --- prevent-cross-worktree-writes.js ---
    // Shipped unconditionally by default (#216): the hook itself no-ops at runtime
    // while the repo has a single worktree, so writing it before any worktree exists
    // is safe and is what makes it present by the time the first worktree IS created.
    const includeWorktree = options.includeWorktreeGuard !== undefined ? options.includeWorktreeGuard : true;
    const worktreeGuardPath = join(hooksDir, "prevent-cross-worktree-writes.js");
    if (includeWorktree) {
      writeBoardHookIfOutdated(worktreeGuardPath, getWorktreeGuardSource());
    }

    // --- smart-hooks-config.json ---
    const smartConfigPath = join(hooksDir, "smart-hooks-config.json");
    if (!existsSync(smartConfigPath)) {
      writeFileSync(smartConfigPath, EMPTY_SMART_HOOKS_CONFIG, "utf8");
    }

    // --- smart-hooks-runner.js (#787) ---
    // The generic, project-agnostic runner that reads the generated smart-hooks-rules.json and
    // gives a driven project's builder incremental PostToolUse/Stop feedback. The rules file
    // itself is generated from the stack profile (writeSmartHooksRules); the runner contains no
    // project-specific logic, so it is safe to copy verbatim into any repo.
    // --- git-topology-cache.js ---
    // Written BEFORE the runner: the runner requires it at load time, so a repo that got the
    // runner without it would throw on every hook call (#392).
    const topologyCachePath = join(hooksDir, "git-topology-cache.js");
    writeBoardHookIfOutdated(topologyCachePath, getTopologyCacheSource());

    const smartRunnerPath = join(hooksDir, "smart-hooks-runner.js");
    writeBoardHookIfOutdated(smartRunnerPath, getSmartRunnerSource());
    const smartRunnerWritten = existsSync(smartRunnerPath);

    // --- hooks README ---
    const readmePath = join(hooksDir, "README.md");
    if (!existsSync(readmePath)) {
      writeFileSync(readmePath, HOOKS_README, "utf8");
    }

    // --- .claude/settings.json — append hook entries ---
    const settingsPath = join(repoPath, ".claude", "settings.json");
    const newEntries: { event: string; matcher?: string; command: string }[] = [
      {
        event: "PreToolUse",
        matcher: "Bash|PowerShell",
        command: "node $CLAUDE_PROJECT_DIR/.claude/hooks/vital-file-guard.js",
      },
    ];
    if (includeWorktree) {
      newEntries.push({
        event: "PreToolUse",
        matcher: "Write|Edit|MultiEdit|NotebookEdit",
        command: "node $CLAUDE_PROJECT_DIR/.claude/hooks/prevent-cross-worktree-writes.js",
      });
      // Shell vector (#369): the incident commit was made by `cd <main checkout>; git commit -F`,
      // which the Write/Edit matcher above never sees. The guard now inspects shell commands
      // too, so it must ALSO be wired on the shell matcher or the vector stays open.
      newEntries.push({
        event: "PreToolUse",
        matcher: "Bash|PowerShell",
        command: "node $CLAUDE_PROJECT_DIR/.claude/hooks/prevent-cross-worktree-writes.js",
      });
    }
    // Wire the edit-time feedback runner only when its source was actually delivered (#787),
    // so we never reference a runner the repo doesn't have.
    if (smartRunnerWritten) {
      newEntries.push({
        event: "PostToolUse",
        matcher: "Write|Edit|MultiEdit",
        command: "node $CLAUDE_PROJECT_DIR/.claude/hooks/smart-hooks-runner.js PostToolUse",
      });
      newEntries.push({
        event: "Stop",
        command: "node $CLAUDE_PROJECT_DIR/.claude/hooks/smart-hooks-runner.js Stop",
      });
    }
    mergeSettingsHooks(settingsPath, newEntries);
  } catch {
    /* non-fatal */
  }
}

// ---------------------------------------------------------------------------
// Verify-gate runner scaffold
// ---------------------------------------------------------------------------

const VERIFY_GATE_CONFIG_STUB =
  JSON.stringify({ command: "", maxRepairAttempts: 3 }, null, 2) + "\n";

/**
 * Copy the generic verify-gate runner and its config stub into .claude/hooks/.
 * - Never overwrites an existing runner (idempotent, clobber-safe).
 * - Creates the hooks dir if absent.
 * Non-fatal on any error.
 *
 * The runner source is resolved via resolveHookSource: packaged copy first
 * (dist/scaffold/hooks/, shipped in the npm tarball — the path npx installs
 * use), then the canonical tested copy in src/scaffold/, then the dev-checkout
 * .claude/hooks/ walk-up. Missing source logs a loud warning (#952).
 */
export function ensureVerifyGateRunner(repoPath: string): void {
  try {
    const hooksDir = join(repoPath, ".claude", "hooks");
    if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

    const destRunner = join(hooksDir, "verify-gate-runner.js");
    if (!existsSync(destRunner)) {
      const src = resolveHookSource("verify-gate-runner.js");
      if (src) writeFileSync(destRunner, src, "utf8");
    }

    const destConfig = join(hooksDir, "verify-gate.config.json");
    if (!existsSync(destConfig)) {
      writeFileSync(destConfig, VERIFY_GATE_CONFIG_STUB, "utf8");
    }

    // Part of the quality gate: a scaffolded project must actually build on a clean checkout
    // regardless of its package manager (#789). For pnpm this approves esbuild's native build
    // so `pnpm install && pnpm build` doesn't fail with ERR_PNPM_IGNORED_BUILDS (#777); for
    // bun it trusts the same native deps; for npm/yarn/bun it pins the engine so the lockfile
    // resolves under the right manager. Non-Node stacks (cargo/go/python) build clean already.
    ensureBuildableFromClean(repoPath);
  } catch {
    /* non-fatal: scaffolding must never block registration */
  }
}

/**
 * Resolve the default onboarding skill (board-navigator) so a freshly-registered project's
 * worktrees aren't skill-less. Returns null gracefully if the builtin isn't seeded. (#531)
 */
export async function getDefaultSkillId(database: Database = db): Promise<string | null> {
  return getBoardNavigatorSkillId(database);
}
