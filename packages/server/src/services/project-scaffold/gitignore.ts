import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

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
  ".verify/", // the directory visual-verification is told to write screenshots/logs into
  "/*-review.png", // reviewer screenshots that miss the verify-*.png pattern
  // Board-generated per-workspace state: the service-stack env file (allocated ports +
  // the project's servicesConfig secrets, e.g. POSTGRES_PASSWORD) plus conductor state.
  // Machine-written, never project source — committing it leaks credentials into
  // history and churns every diff/review. Provisioning also drops a self-ignoring
  // .kanban/.gitignore sentinel; this entry covers the main checkout and repos where
  // the sentinel write failed.
  ".kanban/",
  // Board-materialized agent skills (#40). `workspace-provision.service.ts` writes
  // `.claude/skills/<name>/SKILL.md` into EVERY worktree at create time from the
  // `agent_skills` table, and symlinks `.codex/skills` -> `.claude/skills`. They are
  // per-workspace prompt material, regenerated on every create — not project source.
  // Unignored, the agent's end-of-task sweep commits them into the DRIVEN project's
  // history and every review diff (observed: 2 of 4 "changed files" on a real ticket
  // were board prompts, the same content committed TWICE via the symlink).
  //
  // Deliberate tradeoff: a repo that authors its OWN skills here (agentic-kanban does)
  // keeps them — gitignore does not untrack already-tracked files, so committed skills
  // are unaffected. The cost is that a NEW hand-authored skill needs `git add -f`.
  // That one-off friction on the rare authoring repo beats polluting every driven
  // project's history on every ticket.
  //
  // Contrast DURABLE_CLAUDE_SCAFFOLD_PATHS (.claude/settings.json, .claude/hooks/*),
  // which are durable project config and stay committed (via `git add -f`).
  ".claude/skills/",
  ".codex/skills", // no trailing slash: the board creates it as a symlink, not a dir
];

const AGENT_GITIGNORE_HEADER = "# AI agent artifacts (written during a workspace session; not project source)";
const STACK_BUILD_GITIGNORE_HEADER = "# Build output (per-stack; generated, not source — keeps a fresh worktree's main clean for auto-merge)";

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
  // `.kotlin/` holds the Kotlin daemon's session markers (`.kotlin/sessions/*.salive`), rewritten
  // on EVERY gradle build. Committed once, they churn the main checkout into `dirty_main` and block
  // all merges until untracked (#122, observed on a real Kotlin/Gradle project). Kotlin is detected
  // as the coarse "java" family, so it belongs here — harmless on a pure-Java repo, which never
  // creates the directory.
  java: ["target/", "build/", "*.class", ".gradle/", ".kotlin/", "out/"],
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
