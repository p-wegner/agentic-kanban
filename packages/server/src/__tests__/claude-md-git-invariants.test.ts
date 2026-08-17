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
    const bad = commands.filter((c) => !c.includes("$CLAUDE_PROJECT_DIR/") || c.includes("\\"));
    expect(
      bad,
      `hook commands must be "$CLAUDE_PROJECT_DIR/..."-anchored with forward slashes:\n${bad.join("\n")}`,
    ).toEqual([]);
  });
});

/**
 * Left OUT of this file, deliberately:
 *
 *  - "project-specific skills are not in builtin-skills.ts" as a SET-EQUALITY against
 *    `.claude/skills` dirs. That directory also holds plugin skills junctioned in on
 *    enable, so its contents vary per machine and per enabled plugin — the assertion
 *    would fail for reasons unrelated to the rule.
 *  - CLAUDE.md ↔ `buildBoardFeedbackSection` lockstep. Asserting prose appears in two
 *    places pins wording, not behaviour, and goes stale on any rewording; the two would
 *    need a shared constant to be worth testing.
 *  - kill-all-node / `$pid` cases for the safety hook. Those belong in
 *    `command-safety-guard.test.ts` next to the other 34 black-box cases, not here.
 */
