import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
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
