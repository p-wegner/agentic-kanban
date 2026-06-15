import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { agentSkills } from "@agentic-kanban/shared/schema";
import { getCurrentBranch } from "@agentic-kanban/shared/lib/git-service";
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
  ".claude/hooks/.verify-gate-state.json",
  ".claude/hooks/.verify-gate-escalation.json",
  ".claude/scheduled_tasks.lock",
  // App-run capture logs the board's smoke/visual-verification (agent-launched `gradlew run`
  // / dev-server) leaves in the repo ROOT (#825). The reviewer invents arbitrary names
  // (app.log, app2.log, final-run.log, gallery-stderr.log, install3.log, …), so the only robust
  // catch is a ROOT-level `*.log` ignore. Anchored with "/" so a project's own logs/*.log is
  // unaffected; root-level .log files in a checkout are virtually always runtime/agent artifacts.
  "/*.log",
  "/classpath.txt",
];

const AGENT_GITIGNORE_HEADER = "# AI agent artifacts (written during a workspace session; not project source)";
const STACK_BUILD_GITIGNORE_HEADER = "# Build output (per-stack; generated, not source — keeps a fresh worktree's main clean for auto-merge)";
const SCAFFOLD_COMMIT_MESSAGE = "chore: scaffold agent guards and onboarding";
const DURABLE_CLAUDE_SCAFFOLD_PATHS = [
  ".claude/settings.json",
  ".claude/hooks/README.md",
  ".claude/hooks/smart-hooks-runner.js",
  ".claude/hooks/vital-file-guard.js",
  ".claude/hooks/vital-files.json",
  ".claude/hooks/prevent-cross-worktree-writes.js",
  ".claude/hooks/smart-hooks-config.json",
  ".claude/hooks/verify-gate-runner.js",
  ".claude/hooks/verify-gate.config.json",
  ".claude/smart-hooks-rules.json",
];

/**
 * Per-stack build/compile output that a builder agent inevitably produces in a worktree but that
 * is NOT project source. Without these ignored, a cargo/python/java toy-project leaves `target/`,
 * `__pycache__/`, `dist/`, `*.class` etc. untracked after the first build, which makes the main
 * checkout dirty and blocks auto-merge (`dirty_main`) — a recurring obstacle on fresh non-Node
 * projects (#811). The generic Node/TS case was already covered ad-hoc by language templates; this
 * extends the same protection to every stack the profile detector recognizes.
 *
 * Keyed by the coarse `StackProfile.stack` family. Lines are .gitignore patterns, deduped against
 * whatever the repo already ignores, so this never clobbers a hand-written .gitignore.
 */
export const STACK_BUILD_ARTIFACT_GITIGNORE: Record<string, string[]> = {
  node: ["node_modules/", "dist/", "build/", "*.tsbuildinfo", ".next/", "coverage/"],
  rust: ["target/", "**/*.rs.bk"],
  go: ["bin/", "*.exe", "*.test", "*.out"],
  python: ["__pycache__/", "*.py[cod]", "*.egg-info/", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/", "build/", "dist/", ".venv/"],
  java: ["target/", "build/", "*.class", ".gradle/", "out/"],
  ruby: ["*.gem", ".bundle/", "vendor/bundle/", "tmp/"],
  elixir: ["_build/", "deps/", "*.beam", "cover/"],
};

/**
 * Build-artifact .gitignore lines for a stack family, or [] for an unknown/null stack.
 * Pure — callers feed the result into `ensureAgentGitignore` so per-stack output stays untracked.
 */
export function stackBuildArtifactGitignore(stack: string | null | undefined): string[] {
  if (!stack) return [];
  return STACK_BUILD_ARTIFACT_GITIGNORE[stack] ?? [];
}

function statusLineToPath(line: string): string {
  const raw = line.slice(3).trim();
  if (!raw) return "";
  const arrow = raw.indexOf(" -> ");
  return arrow >= 0 ? raw.slice(arrow + 4) : raw;
}

function isScaffoldTrackedPath(pathName: string): boolean {
  if (pathName === ".gitignore" || pathName === "CLAUDE.md" || pathName === "AGENTS.md") return true;
  return pathName === ".claude" || pathName.startsWith(".claude/");
}

/**
 * Commit board-authored scaffold files in the main checkout so future workspace
 * worktrees fork from a clean main branch and auto-merge does not fail on dirty_main.
 *
 * Behavior:
 * - non-fatal on all failures (registration must not block),
 * - no-op on detached HEAD (explicitly skip),
 * - no-op unless one of the scaffold paths changed in git status,
 * - commits only the scaffold paths by explicit message.
 */
export async function commitProjectScaffoldArtifacts(repoPath: string): Promise<void> {
  try {
    const branch = await getCurrentBranch(repoPath);
    if (branch === "HEAD") return;

    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });

    const pathsToCommit = new Set<string>();
    for (const line of status.split("\n")) {
      const pathName = statusLineToPath(line);
      if (!isScaffoldTrackedPath(pathName)) continue;

      if (pathName === ".gitignore") pathsToCommit.add(".gitignore");
      if (pathName === "CLAUDE.md") pathsToCommit.add("CLAUDE.md");
      if (pathName === "AGENTS.md") pathsToCommit.add("AGENTS.md");
    }

    for (const pathName of DURABLE_CLAUDE_SCAFFOLD_PATHS) {
      if (existsSync(join(repoPath, ...pathName.split("/")))) pathsToCommit.add(pathName);
    }

    if (pathsToCommit.size === 0) return;
    const paths = [...pathsToCommit];
    const regularPaths = paths.filter((pathName) => !pathName.startsWith(".claude/"));
    const claudePaths = paths.filter((pathName) => pathName.startsWith(".claude/"));

    if (regularPaths.length > 0) {
      execFileSync("git", ["add", "-A", "--", ...regularPaths], {
        cwd: repoPath,
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
    }
    if (claudePaths.length > 0) {
      execFileSync("git", ["add", "-f", "--", ...claudePaths], {
        cwd: repoPath,
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
    }

    try {
      execFileSync("git", ["diff", "--cached", "--quiet", "--", ...paths], {
        cwd: repoPath,
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
      return;
    } catch {
      execFileSync("git", ["commit", "-m", SCAFFOLD_COMMIT_MESSAGE, "--", ...paths], {
        cwd: repoPath,
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
    }
  } catch {
    /* non-fatal: registration must never fail because of scaffold commit */
  }
}

/**
 * Ensure the generic agent-artifact ignore lines (and, when a stack is known, that stack's
 * build-output lines) are present in the repo's .gitignore.
 * - No .gitignore: write the optional language template, then the agent block, then the
 *   per-stack build-artifact block (when a stack is given).
 * - Existing .gitignore: append only the lines (from either block) that aren't already present.
 * Clobber-safe and idempotent — never rewrites or removes existing entries; a second run with
 * the same stack is a no-op. Non-fatal on any error.
 *
 * @param stack the coarse `StackProfile.stack` family (e.g. "rust", "python", "java"). When given,
 *   the matching build-output patterns are added so a non-Node stack's build output never makes
 *   the main checkout dirty and blocks auto-merge (#811). Omit (or pass null) to skip — e.g. when
 *   the stack is not yet known.
 */
export function ensureAgentGitignore(repoPath: string, languageTemplate?: string, stack?: string | null): void {
  try {
    const gitignorePath = join(repoPath, ".gitignore");
    const stackLines = stackBuildArtifactGitignore(stack);
    const stackBlock = stackLines.length
      ? `\n${STACK_BUILD_GITIGNORE_HEADER}\n${stackLines.join("\n")}\n`
      : "";

    if (!existsSync(gitignorePath)) {
      const base = languageTemplate ? languageTemplate.replace(/\s*$/, "") + "\n\n" : "";
      writeFileSync(
        gitignorePath,
        `${base}${AGENT_GITIGNORE_HEADER}\n${GENERIC_AGENT_GITIGNORE.join("\n")}\n${stackBlock}`,
        "utf8",
      );
      return;
    }

    const existing = readFileSync(gitignorePath, "utf8");
    const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
    const missingAgent = GENERIC_AGENT_GITIGNORE.filter((line) => !present.has(line));
    const missingStack = stackLines.filter((line) => !present.has(line));
    if (missingAgent.length === 0 && missingStack.length === 0) return;

    const sep = existing.endsWith("\n") ? "" : "\n";
    let appended = sep;
    if (missingAgent.length) appended += `\n${AGENT_GITIGNORE_HEADER}\n${missingAgent.join("\n")}\n`;
    if (missingStack.length) appended += `\n${STACK_BUILD_GITIGNORE_HEADER}\n${missingStack.join("\n")}\n`;
    appendFileSync(gitignorePath, appended);
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
- Visual verification is board-owned. Configure it in Project Settings with
  \`visual_verification_mode\` and \`after_merge_verify_agent\`; builders should not install browsers,
  run Playwright, take screenshots, or attach visual proof during implementation.

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

/**
 * A generic, project-agnostic starter AGENTS.md. **Codex reads AGENTS.md, not CLAUDE.md**, so a
 * freshly scaffolded project must carry the same working-agreement/safety baseline here AND a
 * compact PowerShell + codex pitfalls block. Without it, every new codex project re-pays the
 * "shell tax" — the recurring path-not-found / ParserError / $pid-automatic / native-stderr
 * failures (codex on one project: 503 shell calls, 28 failures; fleet PowerShell fails ~17%).
 * Keep this SHORT — it is read into every codex builder's context each session.
 */
export const STARTER_AGENTS_MD = `# AGENTS.md

Guidance for AI coding agents (codex reads THIS file, not CLAUDE.md) working in this repository.
Edit freely to fit this project's stack and conventions.

## Working agreement
- **Commit your work when the task is done** — don't wait to be asked. Each ticket should end in a
  commit on the workspace branch; the board reviews and merges from there.
- **Stay in scope.** Change only what the ticket asks. File a separate ticket for unrelated bugs.
- **Leave the worktree clean.** Commit (or delete) any files you create — stray uncommitted files
  block the automatic merge.

## Safety
- **Never run destructive git** (\`git reset --hard\`, \`git push --force\`, history rewrites) and
  don't delete files you didn't create. Prefer additive, reversible changes.
- Visual verification is board-owned. Configure it with \`visual_verification_mode\` and
  \`after_merge_verify_agent\`; builders should not install browsers, run Playwright, take
  screenshots, or attach visual proof during implementation.

## Use the right tool, not the shell
Reach for a dedicated tool before a shell command — it's faster and doesn't fail on quoting.
- **Read a file** with the read/view tool, **NOT** \`Get-Content\` / \`cat\`.
- **Search** with the grep/search tool, **NOT** \`Select-String\` / \`findstr\`.
- **Find files** with the glob/find tool, **NOT** \`Get-ChildItem -Recurse\`.
- Prefer the board's MCP tools for board/issue/workspace operations over hand-rolled HTTP.

## Windows PowerShell pitfalls (this is a Windows shell — these recur constantly)
- **No \`&&\`, \`||\`, ternary, or \`??\`** (PowerShell 5.1). Run commands on separate lines, or use
  \`;\` (unconditional) / \`if ($?) { ... }\` (conditional-on-success).
- **Don't redirect native-exe stderr with \`2>&1\`** — PS 5.1 wraps each line as an ErrorRecord and
  flips \`$?\`/exit to *failure on success*. stderr is already captured; leave it alone.
- **Never name a variable \`$pid\`, \`$host\`, \`$home\`, \`$true\`, \`$null\`, or \`$pshome\`** — they are
  read-only automatic variables; assigning silently keeps the built-in (so an id ends up wrong).
  Use \`$procId\` / \`$projectId\` instead.
- **\`$var:\` parses as a drive reference** — write \`"\${name}:"\` when a var is followed by a colon.
- **Quote paths with spaces**, and avoid unterminated strings — a stray quote yields
  \`ParserError: unterminated string\` and the whole command fails before it runs.
- **\`-Path\` that doesn't exist throws \`path ... does not exist\`** — verify with \`Test-Path\` first
  rather than assuming a relative path resolves from the current directory.
- PS 5.1 has **no Unix \`head\`/\`tail\`/\`which\`/\`touch\`/\`grep\`** — use the dedicated read/search
  tools above. Default file encoding is UTF-16; pass \`-Encoding utf8\` when writing files other
  tools must read.

## Agent artifacts
Local scratch files (\`CLAUDE.local.md\`, \`HANDOFF.md\`, \`verify-*.png\`, \`.playwright-cli/\`) are
gitignored on purpose — they are not project source. Don't commit them.
`;

/** Write a starter AGENTS.md only if the repo doesn't already have one. Non-fatal. */
export function ensureStarterAgentsMd(repoPath: string): void {
  try {
    const agentsMdPath = join(repoPath, "AGENTS.md");
    if (!existsSync(agentsMdPath)) writeFileSync(agentsMdPath, STARTER_AGENTS_MD, "utf8");
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

let _smartRunnerSource: string | null | undefined = undefined;
function getSmartRunnerSource(): string | null {
  if (_smartRunnerSource === undefined) _smartRunnerSource = resolveHookSource("smart-hooks-runner.js");
  return _smartRunnerSource;
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
 * The runner source is resolved via resolveHookSource (same walk-up pattern
 * used by ensureHookScaffold) so this works in both dev (src/) and production
 * (dist/ bundles) without relying on import.meta.url-relative paths that
 * tsc does not copy to dist/.
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
  const pm = typeof pkg.packageManager === "string" ? (pkg.packageManager as string) : "";
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
  // approval, but DON'T pin a manager onto a repo that hasn't chosen one.
  return { pm: "pnpm", pinnable: false };
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
 * Returns true if it changed any file (so callers can commit the repair). Clobber-safe,
 * idempotent, non-fatal. Never clobbers a deliberate `packageManager` choice the project
 * already made.
 */
export function ensureBuildableFromClean(repoPath: string): boolean {
  let changed = false;
  try {
    const pkgJsonPath = join(repoPath, "package.json");
    if (existsSync(pkgJsonPath)) {
      const raw = readFileSync(pkgJsonPath, "utf8");
      let pkg: Record<string, unknown>;
      try {
        pkg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        pkg = {};
      }
      let pkgChanged = false;

      const { pm, pinnable } = detectNodePmForApproval(repoPath, pkg);

      // 1. Approve native build scripts under the strict managers that block them by default.
      if (pm === "pnpm") {
        // pnpm: `pnpm.onlyBuiltDependencies` is the canonical approval mechanism.
        const pnpmCfg = (pkg.pnpm ?? {}) as Record<string, unknown>;
        if (mergeApprovedDeps(pnpmCfg, "onlyBuiltDependencies")) {
          pkg.pnpm = pnpmCfg;
          pkgChanged = true;
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
        changed = true;
      }
    }

    // Repair a broken pnpm-workspace.yaml: a placeholder OR a bogus `allowBuilds:` block
    // (not a real pnpm key — the old repair left `allowBuilds: esbuild: true`, a silent no-op).
    // Replace it with a VALID `onlyBuiltDependencies:` list.
    const wsPath = join(repoPath, "pnpm-workspace.yaml");
    if (existsSync(wsPath)) {
      const ws = readFileSync(wsPath, "utf8");
      if (ws.includes(PNPM_PLACEHOLDER_MARKER) || /^\s*allowBuilds\s*:/m.test(ws)) {
        // Drop the bogus `allowBuilds:` key and its indented children.
        let repaired = ws.replace(/^[ \t]*allowBuilds[ \t]*:[ \t]*\r?\n(?:[ \t]+\S.*\r?\n?)*/m, "");
        if (!/^\s*onlyBuiltDependencies\s*:/m.test(repaired)) {
          const list = PNPM_BUILD_APPROVED_DEPS.map((d) => `  - ${d}`).join("\n");
          repaired = repaired.replace(/\s*$/, "\n") + `onlyBuiltDependencies:\n${list}\n`;
        }
        if (repaired !== ws) {
          writeFileSync(wsPath, repaired, "utf8");
          changed = true;
        }
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
