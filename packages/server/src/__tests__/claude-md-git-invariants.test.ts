// @gate:always-run — reads repo files and .claude/settings.json; imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * CLAUDE.md states these as HARD CONSTRAINTS and nothing tested them (#598).
 *
 * Each one is a rule an agent breaks by writing plausible-looking code, and each has a
 * failure that is silent or off-machine — which is exactly the set worth spending a
 * scanner on. They are green today; these tests keep them green.
 *
 * Scoped deliberately to four of the ticket's seven families — see the note at the
 * bottom for the three left out and why.
 */
const repoRoot = path.join(import.meta.dirname!, "..", "..", "..", "..");

function readIfExists(rel: string): string | null {
  const abs = path.join(repoRoot, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
}

function sourceFiles(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (["node_modules", "dist", ".git", "__tests__"].includes(e.name)) continue;
        walk(full);
        continue;
      }
      if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name) && !e.name.includes(".test.")) out.push(full);
    }
  };
  for (const r of roots) walk(path.join(repoRoot, r));
  return out;
}

describe("CLAUDE.md git/worktree invariants (#598)", () => {
  it("the two git-service shims stay ONE re-export line", () => {
    // "Edit only packages/shared/src/lib/git-service.ts" only holds while the other two
    // are pure re-exports. A helper added to a shim becomes a second source of truth that
    // the shared file's tests never see.
    const shims = [
      "packages/server/src/services/git.service.ts",
      "packages/mcp-server/src/git-service.ts",
    ];
    const expected = 'export * from "@agentic-kanban/shared/lib/git-service";';
    for (const rel of shims) {
      const text = readIfExists(rel);
      expect(text, `${rel} is missing`).not.toBeNull();
      const lines = (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
      expect(lines, `${rel} must be exactly the re-export line, not a second git home`).toEqual([expected]);
    }
  });

  it("nothing runs `git reset --soft` (it corrupts a worktree's .git)", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(["packages", ".claude/hooks", "scripts"])) {
      const text = fs.readFileSync(file, "utf8");
      // Both spellings: a shell string, and an argv array like ["reset", "--soft", …].
      if (/reset\s+--soft/.test(text) || /["']reset["']\s*,\s*["']--soft["']/.test(text)) {
        offenders.push(path.relative(repoRoot, file).replaceAll("\\", "/"));
      }
    }
    expect(
      offenders,
      `git reset --soft in a worktree corrupts its .git (CLAUDE.md hard constraint):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("nothing passes --no-edit to `git rebase` (it is a merge flag; rebase rejects it)", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(["packages", ".claude/hooks", "scripts"])) {
      const text = fs.readFileSync(file, "utf8");
      // Only flags the rebase spelling — `merge --no-edit` is correct and common.
      if (/rebase[^\n;]*--no-edit/.test(text) || /["']rebase["'][^\n]*["']--no-edit["']/.test(text)) {
        offenders.push(path.relative(repoRoot, file).replaceAll("\\", "/"));
      }
    }
    expect(
      offenders,
      `git rebase rejects --no-edit ("unknown option"); non-interactive rebase opens no editor anyway:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("every hook command in .claude/settings.json is $CLAUDE_PROJECT_DIR-anchored with forward slashes", () => {
    // A hardcoded absolute path breaks on every other clone and machine; a bare relative
    // path breaks on a CWD shift; a backslash makes node throw MODULE_NOT_FOUND.
    const raw = readIfExists(".claude/settings.json");
    expect(raw, ".claude/settings.json is missing").not.toBeNull();
    const settings = JSON.parse(raw ?? "{}") as { hooks?: Record<string, unknown> };

    const commands: string[] = [];
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(collect);
      if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        if (typeof obj.command === "string") commands.push(obj.command);
        Object.values(obj).forEach(collect);
      }
    };
    // ONLY the hooks section: `mcpServers` entries are launch specs (e.g. `pnpm`), a
    // different shape that this rule does not govern.
    collect(settings.hooks ?? {});

    expect(commands.length, "no hook commands found — the walk broke, not the config").toBeGreaterThan(3);
    // Exactly one deliberate exception (#922): disclose-context.mjs uses a PLAIN RELATIVE
    // path on purpose. $CLAUDE_PROJECT_DIR is empty in `claude -p` sessions (review/one-shot/
    // Pi task agents) and Claude Code pre-expands it textually before spawn, so the anchored
    // form resolves to a bogus drive-root path (e.g. C:\.claude\hooks\...) and fails
    // non-blockingly in exactly the launch mode this hook most needs to run in. The hook
    // self-locates its project root via a `.claude`/`.git` walk-up instead of trusting the
    // env var — see the header of packages/server/src/scaffold/disclose-context.mjs. Every
    // other hook stays subject to the rule; this is not a precedent for a second exception.
    const EXEMPT_COMMANDS = new Set(["node .claude/hooks/disclose-context.mjs"]);
    const bad = commands.filter(
      (c) => !EXEMPT_COMMANDS.has(c) && (!c.includes("$CLAUDE_PROJECT_DIR/") || c.includes("\\")),
    );
    expect(
      bad,
      `hook commands must be "$CLAUDE_PROJECT_DIR/..."-anchored with forward slashes:\n${bad.join("\n")}`,
    ).toEqual([]);
  });
});

/**
 * The other three #598 families live elsewhere, and the objections that kept them out of
 * this file were answered by REFORMULATING them rather than by dropping them:
 *
 *  - project-specific skills vs `builtin-skills.ts`, and the CLAUDE.md ↔
 *    `buildBoardFeedbackSection` lockstep → `claude-md-skill-and-feedback-invariants.test.ts`.
 *    The skill check asks GIT what is tracked instead of reading the directory, so a
 *    junctioned plugin skill (per-machine, never tracked) cannot fail it. The feedback check
 *    pins IDENTIFIERS and the no-silent-fallthrough property instead of prose — and only the
 *    direction that is true: the rendered section names no mode at all, so it asserts that a
 *    worktree is never offered a main-checkout mode, not that it names its own.
 *  - kill-all-node / `$pid` cases for the safety hook → `command-safety-guard.test.ts`,
 *    beside the other black-box cases, as this note originally said they should be.
 */
