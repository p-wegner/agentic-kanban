import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { agentSkills } from "@agentic-kanban/shared/schema";
import { db, type Database } from "../db/index.js";

/**
 * New-project scaffold: the small, project-agnostic, clobber-safe pieces the board writes when a
 * project is created or an existing repo is imported, so a fresh project is hands-off-ready.
 *
 * Deliberately GENERIC — only translate the *ideas* the board relies on; never embed
 * board-specific entries (kanban.db, agentic-kanban paths). Heavier constructs (hook delivery,
 * a verify-gate runner, objective.md, bundling skills into repos) are tracked as separate tickets.
 */

/**
 * Generic artifacts an AI coding agent may write into a worktree during a session — scratch, not
 * project source. Appended (if missing) to every scaffolded/imported project's .gitignore so they
 * never get committed to the project's history (this was a real pollution bug: CLAUDE.local.md /
 * verify-*.png / .playwright-cli landed on a project's master). Project-agnostic ONLY.
 */
export const GENERIC_AGENT_GITIGNORE = [
  "CLAUDE.local.md",
  "HANDOFF.md",
  "verify-*.png",
  ".playwright-cli/",
  ".claude/settings.local.json",
  ".claude/hooks/.edited-files.json",
  ".claude/hooks/.smart-hooks-state.json",
  ".claude/scheduled_tasks.lock",
];

const AGENT_GITIGNORE_HEADER = "# AI agent artifacts (written during a workspace session; not project source)";

/**
 * Ensure the generic agent-artifact ignore lines are present in the repo's .gitignore.
 * - No .gitignore: write the optional language template followed by the agent block.
 * - Existing .gitignore: append only the lines that aren't already present (idempotent).
 * Clobber-safe — never rewrites or removes existing entries. Non-fatal on any error.
 */
export function ensureAgentGitignore(repoPath: string, languageTemplate?: string): void {
  try {
    const gitignorePath = join(repoPath, ".gitignore");
    if (!existsSync(gitignorePath)) {
      const base = languageTemplate ? languageTemplate.replace(/\s*$/, "") + "\n\n" : "";
      writeFileSync(gitignorePath, `${base}${AGENT_GITIGNORE_HEADER}\n${GENERIC_AGENT_GITIGNORE.join("\n")}\n`, "utf8");
      return;
    }
    const existing = readFileSync(gitignorePath, "utf8");
    const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
    const missing = GENERIC_AGENT_GITIGNORE.filter((line) => !present.has(line));
    if (missing.length === 0) return;
    const sep = existing.endsWith("\n") ? "" : "\n";
    appendFileSync(gitignorePath, `${sep}\n${AGENT_GITIGNORE_HEADER}\n${missing.join("\n")}\n`);
  } catch {
    /* non-fatal: scaffolding must never block registration */
  }
}

/**
 * A generic, project-agnostic starter CLAUDE.md. Translates the *ideas* the board relies on
 * (commit-when-done, scope discipline, no destructive git, an optional verify-gate, the
 * gitignored agent artifacts) without copying the board's own board-specific guidance.
 */
export const STARTER_CLAUDE_MD = `# CLAUDE.md

Guidance for AI coding agents working in this repository (and for the agentic-kanban board that
orchestrates them). Edit freely to fit this project's stack and conventions.

## Working agreement
- **Commit your work when the task is done** — don't wait to be asked. Each ticket should end in a
  commit on the workspace branch; the board reviews and merges from there.
- **Stay in scope.** Change only what the ticket asks. If you spot an unrelated bug or improvement,
  create a separate ticket instead of fixing it inline.
- **Leave the worktree clean.** Commit (or delete) any files you create — stray uncommitted files
  block the automatic merge.

## Safety
- **Never run destructive git** (\`git reset --hard\`, \`git push --force\`, history rewrites) and
  don't delete files you didn't create. Prefer additive, reversible changes.
- If an action would erase data or someone else's work, stop and surface it instead of proceeding.

## Quality gate (recommended)
- Set a **Verify Script** for this project (Project Settings -> Verify Script), e.g.
  \`npm test && npm run build\`, \`pytest\`, or \`cargo test\`. The board runs it in your worktree
  after a session and withholds the merge if it fails — so broken code can't be auto-approved.
- Keep the app runnable and prefer adding/maintaining tests for what you change.

## Agent artifacts
Agents may write local scratch files during a session (\`CLAUDE.local.md\`, \`HANDOFF.md\`,
\`verify-*.png\` screenshots, a \`.playwright-cli/\` dir). These are gitignored on purpose — they
are not project source. Don't commit them.
`;

/** Write a starter CLAUDE.md only if the repo doesn't already have one. Non-fatal. */
export function ensureStarterClaudeMd(repoPath: string): void {
  try {
    const claudeMdPath = join(repoPath, "CLAUDE.md");
    if (!existsSync(claudeMdPath)) writeFileSync(claudeMdPath, STARTER_CLAUDE_MD, "utf8");
  } catch {
    /* non-fatal */
  }
}

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

// Module directory — used to locate the canonical hook sources in .claude/hooks/.
// Works in both dev (src/services/) and bundled (dist/) modes by walking up to find .claude/.
const _moduleDir = dirname(fileURLToPath(import.meta.url));

function resolveHookSource(filename: string): string | null {
  // Walk up from the module dir (src/services, dist/, etc.) to the git repo root.
  // The .claude/hooks dir lives at the git repo root — check up to 6 levels up.
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

/** True when the repo has more than one git worktree. */
function repoHasWorktrees(repoPath: string): boolean {
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
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

## smart-hooks-config.json

Config file for the smart-hooks-runner pattern (if you add it later). Currently empty —
add PreToolUse / Stop hook entries here and wire \`smart-hooks-runner.js\` in
\`.claude/settings.json\` to activate them.

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
    mergeSettingsHooks(settingsPath, newEntries);
  } catch {
    /* non-fatal */
  }
}

// ---------------------------------------------------------------------------
// Verify-gate runner scaffold
// ---------------------------------------------------------------------------

const RUNNER_SRC = join(dirname(fileURLToPath(import.meta.url)), "../scaffold/verify-gate-runner.js");

const VERIFY_GATE_CONFIG_STUB = JSON.stringify({ command: "" }, null, 2) + "\n";

/**
 * Copy the generic verify-gate runner and its config stub into .claude/hooks/.
 * - Never overwrites an existing runner (idempotent, clobber-safe).
 * - Creates the hooks dir if absent.
 * Non-fatal on any error.
 */
export function ensureVerifyGateRunner(repoPath: string): void {
  try {
    const hooksDir = join(repoPath, ".claude", "hooks");
    if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

    const destRunner = join(hooksDir, "verify-gate-runner.js");
    if (!existsSync(destRunner) && existsSync(RUNNER_SRC)) {
      writeFileSync(destRunner, readFileSync(RUNNER_SRC, "utf8"), "utf8");
    }

    const destConfig = join(hooksDir, "verify-gate.config.json");
    if (!existsSync(destConfig)) {
      writeFileSync(destConfig, VERIFY_GATE_CONFIG_STUB, "utf8");
    }
  } catch {
    /* non-fatal: scaffolding must never block registration */
  }
}

/**
 * Resolve the default onboarding skill (board-navigator) so a freshly-registered project's
 * worktrees aren't skill-less. Returns null gracefully if the builtin isn't seeded. (#531)
 */
export async function getDefaultSkillId(database: Database = db): Promise<string | null> {
  const [nav] = await database
    .select({ id: agentSkills.id })
    .from(agentSkills)
    .where(eq(agentSkills.name, "board-navigator"))
    .limit(1);
  return nav?.id ?? null;
}
