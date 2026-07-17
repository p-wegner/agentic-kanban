import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
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
   * Include the cross-worktree write guard. Defaults to true only when the repo
   * already has git worktrees (detected via `git worktree list`). Pass explicitly
   * to override.
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

/** True when the repo has more than one git worktree. */
function repoHasWorktrees(repoPath: string): boolean {
  try {
    const out = gitExecSync(["worktree", "list", "--porcelain"], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return (out.match(/^worktree /gm) ?? []).length > 1;
  } catch {
    return false;
  }
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

## prevent-cross-worktree-writes.js (optional)

When this repo uses git worktrees, this hook prevents an agent running in one worktree
from writing into another worktree of the same repo. It is only wired when the repo has
more than one worktree at scaffold time.

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

    // Skip if an entry with this exact command already exists under this event
    const commandAlreadyPresent = arr.some((e) => {
      const innerHooks = (e.hooks as Record<string, unknown>[] | undefined) ?? [];
      return innerHooks.some((h) => h.command === command);
    });
    if (commandAlreadyPresent) continue;

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
 *   .claude/hooks/prevent-cross-worktree-writes.js  — only when worktrees exist (or forced)
 *   .claude/hooks/smart-hooks-config.json — empty runner config
 *   .claude/hooks/README.md               — explains the hooks
 *   .claude/settings.json                 — hook entries appended (never overwritten)
 */
export function ensureHookScaffold(repoPath: string, options: HookScaffoldOptions = {}): void {
  try {
    const hooksDir = join(repoPath, ".claude", "hooks");
    mkdirSync(hooksDir, { recursive: true });

    // --- vital-file-guard.js ---
    const vitalGuardPath = join(hooksDir, "vital-file-guard.js");
    if (!existsSync(vitalGuardPath)) {
      const src = getVitalGuardSource();
      if (src) writeFileSync(vitalGuardPath, src, "utf8");
    }

    // --- vital-files.json ---
    const vitalFilesPath = join(hooksDir, "vital-files.json");
    if (!existsSync(vitalFilesPath)) {
      const list = options.vitalFiles ?? [];
      writeFileSync(vitalFilesPath, JSON.stringify(list, null, 2) + "\n", "utf8");
    }

    // --- prevent-cross-worktree-writes.js (optional) ---
    const includeWorktree =
      options.includeWorktreeGuard !== undefined
        ? options.includeWorktreeGuard
        : repoHasWorktrees(repoPath);
    const worktreeGuardPath = join(hooksDir, "prevent-cross-worktree-writes.js");
    if (includeWorktree && !existsSync(worktreeGuardPath)) {
      const src = getWorktreeGuardSource();
      if (src) writeFileSync(worktreeGuardPath, src, "utf8");
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
    const smartRunnerPath = join(hooksDir, "smart-hooks-runner.js");
    const smartRunnerWritten =
      existsSync(smartRunnerPath) ||
      (() => {
        const src = getSmartRunnerSource();
        if (src) {
          writeFileSync(smartRunnerPath, src, "utf8");
          return true;
        }
        return false;
      })();

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
