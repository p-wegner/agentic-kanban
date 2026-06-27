// @covers git-integration.diff.working-tree [boundary]
//
// Boundary cases for the HAND-ROLLED untracked-file diff synthesis in
// `src/lib/git-service/diff.ts` (`getUntrackedDiffEntries`, reached via
// `getWorkingTreeDiff`). The normal path is already covered by
// `git-service.integration.test.ts` ("getWorkingTreeDiff includes untracked
// files"), `git.service.test.ts`, and `workspace-diff-stats.test.ts`. This file
// adds the two boundary dimensions the synthesis is fragile on:
//   (a) a binary untracked file (NUL bytes) — must NOT crash; characterizes the
//       ACTUAL behaviour (no real binary detection — it is rendered as content).
//   (b) a no-trailing-newline untracked file — the synthesized line count must be
//       correct, pinning the off-by-one in the `lines.pop()` trailing-blank guard.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWorkingTreeDiff } from "../src/lib/git-service.js";

// Repo setup uses the git CLI directly (mirrors the integration exemplar's own
// `git()` helper). The behaviour under test spawns git via the shared adapter
// internally; this helper is test scaffolding only, never a production git path.
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout.toString());
    });
  });
}

async function writeRepoFile(repo: string, relativePath: string, content: string | Buffer): Promise<void> {
  const filePath = join(repo, ...relativePath.split("/"));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

/** Normalize CRLF -> LF so keyword assertions are stable on Windows. */
function lf(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/**
 * Extract the synthesized diff section for one file path. Entries are joined with
 * "\n" and each starts with `diff --git a/<f> b/<f>`. Returns the chunk for `f`
 * up to (but excluding) the next `diff --git` header.
 */
function sectionFor(diff: string, f: string): string {
  const normalized = lf(diff);
  const header = `diff --git a/${f} b/${f}`;
  const start = normalized.indexOf(header);
  if (start === -1) return "";
  const rest = normalized.slice(start + header.length);
  const next = rest.indexOf("\ndiff --git ");
  return header + (next === -1 ? rest : rest.slice(0, next));
}

describe("getUntrackedDiffEntries boundary cases", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "ak-untracked-boundary-"));
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "test@example.local"]);
    await git(repo, ["config", "user.name", "Untracked Boundary Test"]);
    // Need at least one commit so `git diff HEAD` (the tracked half) has a HEAD.
    await writeRepoFile(repo, "README.md", "# seed\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "initial commit"]);
  }, 30000);

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("(a) renders a binary untracked file without crashing", async () => {
    // PNG-ish bytes incl. NUL and high bytes, and crucially NO 0x0a newline byte
    // so the synthesized hunk is a single, deterministic line.
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x41, 0x42]);
    await writeRepoFile(repo, "asset.bin", binary);

    // Must not reject/throw — the catch-all in the synthesis (or its absence)
    // must keep the whole working-tree diff producing a value.
    const diff = await getWorkingTreeDiff(repo);

    const section = sectionFor(diff, "asset.bin");
    expect(section).toContain("diff --git a/asset.bin b/asset.bin");
    expect(section).toContain("new file mode 100644");

    // FIXED behaviour: the synthesis now sniffs for a NUL byte and emits a
    // HEADER-ONLY entry for binary files (git-style "Binary files ... differ"),
    // NOT a `+content` hunk of garbage replacement chars.
    const normalizedSection = lf(section);
    // No content hunk header and no `+` content lines for the binary file.
    expect(normalizedSection).not.toContain("@@ -0,0 +1");
    const plusLines = normalizedSection
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    expect(plusLines).toEqual([]);
    // git-style binary marker present.
    expect(normalizedSection.toLowerCase()).toContain("binary");
    expect(lf(diff)).not.toContain("<<<<<<<");
  }, 30000);

  it("(b) counts lines correctly for a no-trailing-newline untracked file", async () => {
    // Exactly 3 lines, NO trailing newline. The last line is the off-by-one
    // canary: the trailing-blank guard (`if last === "" pop`) must NOT drop it.
    const content = "alpha line\nbeta line\ngamma-last-no-newline";
    await writeRepoFile(repo, "notes.txt", content);

    const diff = await getWorkingTreeDiff(repo);
    const section = sectionFor(diff, "notes.txt");

    expect(section).toContain("diff --git a/notes.txt b/notes.txt");
    // Correct count is 3 — not 2 (over-eager pop) and not 4 (counting a phantom
    // trailing blank). The hunk header pins it.
    expect(section).toContain("@@ -0,0 +1,3 @@");
    // The real last line must survive (would vanish if the guard popped blindly).
    expect(section).toContain("+gamma-last-no-newline");

    const plusLines = lf(section)
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    expect(plusLines).toEqual(["+alpha line", "+beta line", "+gamma-last-no-newline"]);
  }, 30000);

  it("(b') counts lines correctly for a trailing-newline untracked file (no phantom line)", async () => {
    // Mirror case: WITH a trailing newline, the guard SHOULD pop the empty tail so
    // the count stays 3. Together (b)+(b') pin the guard from both directions:
    // remove the guard -> this case over-counts to 4; make it unconditional ->
    // case (b) under-counts to 2. Either mutation turns one of these RED.
    const content = "one\ntwo\nthree\n";
    await writeRepoFile(repo, "withnl.txt", content);

    const diff = await getWorkingTreeDiff(repo);
    const section = sectionFor(diff, "withnl.txt");

    expect(section).toContain("@@ -0,0 +1,3 @@");
    const plusLines = lf(section)
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    expect(plusLines).toEqual(["+one", "+two", "+three"]);
  }, 30000);
});
