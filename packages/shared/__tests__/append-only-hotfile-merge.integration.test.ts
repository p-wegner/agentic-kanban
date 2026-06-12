/**
 * Regression test for ticket #763: serialize-or-isolate append-only hot files.
 *
 * In the Space Invaders board run, every one of 10 parallel-wave tickets appended to a
 * single shared `test/smoke.test.js`. With multiple branches in review at once, only one
 * merge won per master advance and the rest re-conflicted on the shared file — fix-and-merge
 * thrash that stranded workspaces and forced a manual `git merge` on master.
 *
 * The fix: when a merge conflict is ONLY on pure-append hot files (both the target and the
 * feature branch appended distinct trailing content to a shared-ancestor file, with no edits
 * to existing lines), {@link mergeBranch} with `autoResolveAppendConflicts` lands it by
 * concatenating both tails instead of throwing. A non-append (overlapping-edit) conflict still
 * throws and routes to fix-and-merge as before.
 *
 * Scenarios:
 *   1. A 3+ ticket append-only cluster all lands via the plumbing merge — no manual git, no
 *      strand — and master's shared file ends up containing every ticket's appended block.
 *   2. `detectAppendOnlyResolvableConflicts` reports the hot file read-only (pre-flight can
 *      route the member to a normal merge instead of fix-and-merge).
 *   3. Opt-out (no flag) still throws on the same conflict — the auto-resolve is gated.
 *   4. A genuine overlapping edit on the hot file is NOT treated as append — it still throws.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectAppendOnlyResolvableConflicts,
  mergeBranch,
  revParse,
} from "../src/lib/git-service.js";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.toString());
    });
  });
}

const SMOKE = "test/smoke.test.js";
const SEED = "// smoke tests\n";

let repo: string;

async function writeRepoFile(relativePath: string, content: string): Promise<void> {
  const filePath = join(repo, ...relativePath.split("/"));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function fileAtMain(relativePath: string): Promise<string> {
  return git(repo, ["show", `main:${relativePath}`]);
}

/** Cut `branch` from `main`, append `block` to the shared smoke test, and commit. */
async function makeAppendBranch(branch: string, block: string, base = "main"): Promise<void> {
  await git(repo, ["checkout", "-B", branch, base]);
  const current = await readFile(join(repo, ...SMOKE.split("/")), "utf-8");
  await writeRepoFile(SMOKE, current + block);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", `${branch}: append smoke test`]);
}

describe("#763 append-only hot-file merge auto-resolution", () => {
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "ak-763-"));
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "t@t.com"]);
    await git(repo, ["config", "user.name", "Test"]);
    await writeRepoFile(SMOKE, SEED);
    await writeRepoFile("src/index.js", "export const x = 1;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "seed"]);
    await git(repo, ["branch", "-M", "main"]).catch(() => {});
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  it("lands a 3-ticket append-only cluster via the plumbing merge with no manual git or strand", async () => {
    // Three wave tickets, each cut from the SAME base, each appending its own block to
    // the one shared smoke test — the exact Space Invaders shape.
    await makeAppendBranch("feature/ak-1", "test('a', () => {});\n");
    await makeAppendBranch("feature/ak-2", "test('b', () => {});\n");
    await makeAppendBranch("feature/ak-3", "test('c', () => {});\n");

    await git(repo, ["checkout", "main"]);

    // #1 lands cleanly (ahead of base). #2 and #3 are now "behind" and conflict on the
    // shared file — but as pure appends they auto-resolve by concatenation, no fix-and-merge.
    const r1 = await mergeBranch(repo, "feature/ak-1", "main", { autoResolveAppendConflicts: true });
    expect(r1).toMatch(/plumbing-merge|append-merge/);

    const r2 = await mergeBranch(repo, "feature/ak-2", "main", { autoResolveAppendConflicts: true });
    expect(r2).toContain("append-merge");
    expect(r2).toContain(SMOKE);

    const r3 = await mergeBranch(repo, "feature/ak-3", "main", { autoResolveAppendConflicts: true });
    expect(r3).toContain("append-merge");

    // master contains EVERY ticket's appended block, with no conflict markers, and each
    // branch is a true ancestor of main (the work actually landed).
    const merged = await fileAtMain(SMOKE);
    expect(merged).toContain("test('a', () => {});");
    expect(merged).toContain("test('b', () => {});");
    expect(merged).toContain("test('c', () => {});");
    expect(merged).not.toContain("<<<<<<<");
    expect(merged).not.toContain("=======");
    expect(merged).not.toContain(">>>>>>>");

    for (const branch of ["feature/ak-1", "feature/ak-2", "feature/ak-3"]) {
      const branchSha = (await git(repo, ["rev-parse", branch])).trim();
      const mainSha = (await git(repo, ["rev-parse", "main"])).trim();
      await expect(git(repo, ["merge-base", "--is-ancestor", branchSha, mainSha])).resolves.toBeDefined();
    }

    // No merge was ever left in-progress (no manual recovery needed).
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  }, 30000);

  it("detectAppendOnlyResolvableConflicts reports the hot file read-only", async () => {
    await makeAppendBranch("feature/ak-1", "test('a', () => {});\n");
    await makeAppendBranch("feature/ak-2", "test('b', () => {});\n");
    await git(repo, ["checkout", "main"]);
    await mergeBranch(repo, "feature/ak-1", "main", { autoResolveAppendConflicts: true });

    const headBefore = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const resolvable = await detectAppendOnlyResolvableConflicts(repo, "feature/ak-2", "main");
    expect(resolvable).toEqual([SMOKE]);
    // read-only: HEAD did not move
    expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(headBefore);
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  }, 30000);

  it("without the opt-in flag the same append conflict still throws (gated)", async () => {
    await makeAppendBranch("feature/ak-1", "test('a', () => {});\n");
    await makeAppendBranch("feature/ak-2", "test('b', () => {});\n");
    await git(repo, ["checkout", "main"]);
    await mergeBranch(repo, "feature/ak-1", "main");

    await expect(mergeBranch(repo, "feature/ak-2", "main")).rejects.toThrow(/conflict/i);
  }, 30000);

  it("an overlapping EDIT to the hot file is not an append — it still throws", async () => {
    // Both branches edit the SAME existing seed line → genuine conflict, not a pure append.
    await git(repo, ["checkout", "-B", "feature/edit-a", "main"]);
    await writeRepoFile(SMOKE, "// smoke tests A\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "edit-a: change header"]);

    await git(repo, ["checkout", "-B", "feature/edit-b", "main"]);
    await writeRepoFile(SMOKE, "// smoke tests B\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "edit-b: change header"]);

    await git(repo, ["checkout", "main"]);
    await mergeBranch(repo, "feature/edit-a", "main", { autoResolveAppendConflicts: true });

    expect(await detectAppendOnlyResolvableConflicts(repo, "feature/edit-b", "main")).toBeNull();
    await expect(
      mergeBranch(repo, "feature/edit-b", "main", { autoResolveAppendConflicts: true }),
    ).rejects.toThrow(/conflict/i);
  }, 30000);

  it("revParse stays usable as a smoke check of the temp repo", async () => {
    expect((await revParse(repo, "HEAD")).length).toBeGreaterThan(0);
  });
});
