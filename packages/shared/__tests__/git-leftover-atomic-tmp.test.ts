// @covers git-integration.rebase.leftover-commit [boundary]
//
// #1384: commitLeftoverChanges must not commit atomic-write temp files
// (`<name>.tmp.<pid>.<hex>`) left behind by a killed session.
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitLeftoverChanges } from "../src/lib/git-service/rebase.js";

const GIT_IO_TIMEOUT_MS = Number(process.env.VITEST_GIT_IO_TIMEOUT) || 120_000;

// Test scaffolding only, never a production git path.
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.toString());
    });
  });
}

describe("commitLeftoverChanges atomic-write temp files (#1384)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "leftover-tmp-"));
    await git(dir, ["init", "-q"]);
    await git(dir, ["config", "user.email", "t@t.local"]);
    await git(dir, ["config", "user.name", "t"]);
    await writeFile(join(dir, "foo.ts"), "a\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "init"]);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("commits only the real edit and deletes the stray temp file", async () => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "foo.ts"), "b\n");
    await writeFile(join(dir, "foo.ts.tmp.123.abcdef"), "partial");
    await writeFile(join(dir, "sub", "bar.ts.tmp.2264.a8d045567744"), "partial");

    const n = await commitLeftoverChanges(dir);

    expect(n).toBe(1);
    const files = (await git(dir, ["show", "--name-only", "--format=", "HEAD"])).trim();
    expect(files).toBe("foo.ts");
    expect(existsSync(join(dir, "foo.ts.tmp.123.abcdef"))).toBe(false);
    expect(existsSync(join(dir, "sub", "bar.ts.tmp.2264.a8d045567744"))).toBe(false);
    expect(await readFile(join(dir, "foo.ts"), "utf8")).toBe("b\n");
  }, GIT_IO_TIMEOUT_MS);

  it("makes no commit when only stray temp files exist", async () => {
    await writeFile(join(dir, "foo.ts.tmp.123.abcdef"), "partial");
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    expect(await commitLeftoverChanges(dir)).toBe(0);
    expect((await git(dir, ["rev-parse", "HEAD"])).trim()).toBe(head);
  }, GIT_IO_TIMEOUT_MS);
});
