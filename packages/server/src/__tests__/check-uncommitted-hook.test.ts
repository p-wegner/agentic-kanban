/**
 * Regression tests for the check-uncommitted Stop hook deletion-vs-edit
 * classification (ticket #771, bug 2).
 *
 * A working tree dominated by DELETED tracked source files (`D` in porcelain) is a
 * merge working-tree desync to RESTORE — never a set of changes to COMMIT. The hook
 * must never tell the agent to "commit them before stopping" when the tree is full of
 * deletions; following that would delete packages/shared from the branch. These tests
 * exercise the pure classifier plus the porcelain parser against a real temp git repo.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const requireCjs = createRequire(import.meta.url);
// Hook lives at repo-root/.claude/hooks/check-uncommitted.js. From
// packages/server/src/__tests__ that's five levels up.
const hookPath = resolve(import.meta.dirname, "..", "..", "..", "..", ".claude", "hooks", "check-uncommitted.js");
const { classifyStranded, trackedSourceChanges } = requireCjs(hookPath) as {
  classifyStranded: (c: { edited: string[]; deleted: string[]; all: string[] }) => { action: string; files?: string[]; deleted?: string[]; edited?: string[] };
  trackedSourceChanges: (cwd: string) => { edited: string[]; deleted: string[]; all: string[] };
};

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((res, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else res(stdout.toString());
    });
  });
}

async function writeFileIn(repo: string, rel: string, content: string): Promise<void> {
  const p = join(repo, ...rel.split("/"));
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content);
}

describe("check-uncommitted hook — classifyStranded (deletion vs edit)", () => {
  it("returns ok when nothing is stranded", () => {
    expect(classifyStranded({ edited: [], deleted: [], all: [] })).toEqual({ action: "ok" });
  });

  it("returns commit for a genuine stranded edit", () => {
    const c = { edited: ["packages/server/src/x.ts"], deleted: [], all: ["packages/server/src/x.ts"] };
    expect(classifyStranded(c)).toEqual({ action: "commit", files: c.all });
  });

  it("returns restore for a deletion-dominant working tree (mass-deletion desync)", () => {
    const deleted = Array.from({ length: 120 }, (_, i) => `packages/shared/src/f${i}.ts`);
    const v = classifyStranded({ edited: [], deleted, all: deleted });
    expect(v.action).toBe("restore");
    expect(v.deleted).toHaveLength(120);
  });

  it("returns restore when deletions tie or outnumber edits", () => {
    // 2 deletions vs 1 edit → desync wins (deletions are the dangerous signal).
    const v = classifyStranded({
      edited: ["packages/server/src/a.ts"],
      deleted: ["packages/shared/src/b.ts", "packages/shared/src/c.ts"],
      all: ["packages/server/src/a.ts", "packages/shared/src/b.ts", "packages/shared/src/c.ts"],
    });
    expect(v.action).toBe("restore");
  });

  it("returns commit when edits dominate over a stray deletion", () => {
    const v = classifyStranded({
      edited: ["packages/server/src/a.ts", "packages/server/src/b.ts", "packages/server/src/c.ts"],
      deleted: ["packages/server/src/old.ts"],
      all: ["packages/server/src/a.ts", "packages/server/src/b.ts", "packages/server/src/c.ts", "packages/server/src/old.ts"],
    });
    expect(v.action).toBe("commit");
  });
});

describe("check-uncommitted hook — trackedSourceChanges porcelain parsing", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "ak-uncommitted-hook-"));
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.email", "t@t"]);
    await git(repo, ["config", "user.name", "t"]);
    for (let i = 0; i < 5; i++) {
      await writeFileIn(repo, `packages/shared/src/f${i}.ts`, `export const f${i} = ${i};\n`);
    }
    await writeFileIn(repo, "packages/server/src/keep.ts", "export const keep = 1;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "seed"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("classifies removed-from-disk tracked source files as deletions, driving a restore verdict", async () => {
    // Simulate the desync: the shared source tree removed from disk, HEAD still has it.
    for (let i = 0; i < 5; i++) {
      await rm(join(repo, "packages", "shared", "src", `f${i}.ts`), { force: true });
    }
    const changes = trackedSourceChanges(repo);
    expect(changes.deleted).toHaveLength(5);
    expect(changes.edited).toHaveLength(0);
    expect(classifyStranded(changes).action).toBe("restore");
  });

  it("classifies an edited tracked source file as an edit, driving a commit verdict", async () => {
    await writeFileIn(repo, "packages/server/src/keep.ts", "export const keep = 2; // edited\n");
    const changes = trackedSourceChanges(repo);
    expect(changes.edited).toEqual(["packages/server/src/keep.ts"]);
    expect(changes.deleted).toHaveLength(0);
    expect(classifyStranded(changes).action).toBe("commit");
  });

  it("ignores untracked files and non-source paths", async () => {
    await writeFileIn(repo, "packages/server/notes.md", "scratch\n");
    await writeFileIn(repo, "screenshot.png", "binary\n");
    const changes = trackedSourceChanges(repo);
    expect(changes.all).toHaveLength(0);
    expect(classifyStranded(changes)).toEqual({ action: "ok" });
  });
});
