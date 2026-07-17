import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
