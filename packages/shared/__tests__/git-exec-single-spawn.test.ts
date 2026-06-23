import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture gate: the git CLI may be spawned from exactly ONE place —
 * `packages/shared/src/lib/git-exec.ts`, the sanctioned git adapter. Every other
 * module must go through its `gitExec` / `gitExecOrThrow` / `gitExecSync`
 * primitives instead of calling `child_process` on `git` directly.
 *
 * This keeps the Windows quirks (`windowsHide`), buffer limits, timeouts and error
 * normalisation in one adapter, and makes git a single replaceable boundary
 * (clean-architecture port). It also prevents the historical drift where ~17
 * services each grew their own private `execGit` helper while the docs claimed a
 * single source of truth.
 *
 * Tests are excluded: they legitimately drive real git to build fixtures.
 */

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

/** The only file allowed to spawn `git` via child_process. Relative to REPO_ROOT. */
const ALLOWLIST = new Set([join("packages", "shared", "src", "lib", "git-exec.ts")]);

/** Raw spawn of a literal `git` command: execFile("git"…, execSync(`git …`, spawn("git"…, etc. */
const RAW_GIT_SPAWN = /\b(?:exec|spawn)\w*\(\s*[`"']git(?:[\s`"'])/g;

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

function lineAt(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const lineEnd = text.indexOf("\n", index);
  return text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
}

function isExcluded(absPath: string): boolean {
  const parts = absPath.split(sep);
  return (
    parts.includes("node_modules") ||
    parts.includes("dist") ||
    parts.includes(".worktrees") ||
    parts.includes("__tests__") ||
    absPath.endsWith(".test.ts") ||
    absPath.endsWith(".spec.ts")
  );
}

function collectSourceFiles(dir: string, out: string[]): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (isExcluded(full)) continue;
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
}

describe("git-exec single-spawn gate", () => {
  it("detects raw git spawns when the command literal is on the next line", () => {
    const source = `const output = execFileSync(
      "git",
      ["status"],
    );`;

    expect([...source.matchAll(RAW_GIT_SPAWN)]).toHaveLength(1);
  });

  it("no package source spawns git outside the git-exec adapter", () => {
    const packagesDir = join(REPO_ROOT, "packages");
    const files: string[] = [];
    for (const pkg of readdirSync(packagesDir)) {
      if (pkg === ".worktrees") continue;
      collectSourceFiles(join(packagesDir, pkg, "src"), files);
    }

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(REPO_ROOT, file);
      if (ALLOWLIST.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(RAW_GIT_SPAWN)) {
        offenders.push(`${rel}:${lineNumberAt(text, match.index)}  ${lineAt(text, match.index)}`);
      }
    }

    expect(
      offenders,
      `These files spawn git directly instead of importing the adapter from ` +
        `@agentic-kanban/shared/lib/git-exec:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the adapter itself is the sanctioned spawn site (allowlist is live, not stale)", () => {
    const adapter = readFileSync(join(REPO_ROOT, "packages", "shared", "src", "lib", "git-exec.ts"), "utf8");
    RAW_GIT_SPAWN.lastIndex = 0;
    expect(RAW_GIT_SPAWN.test(adapter)).toBe(true);
  });
});
