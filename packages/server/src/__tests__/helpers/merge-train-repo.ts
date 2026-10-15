import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";

/**
 * Real-git fixture shared by the merge-train suites (#1511). `repo` is a live ESM binding that is
 * reassigned before each test, so a suite reads it exactly as it did when it was a file-local.
 * The suite was split in three so vitest can run them on separate workers: the cost is ~1000 git
 * spawns at 0.2-1 s each, and one file runs its tests strictly one after another.
 */
export let repo: string;

// NOTE: gitExecOrThrow takes an OPTIONS OBJECT. Passing a bare cwd string leaves cwd
// undefined, so every git call silently runs in the process cwd (packages/server) — which
// once created a stray nested repo there. Always pass `{ cwd }`.
export async function git(args: string[], cwd = repo) {
  return gitExecOrThrow(args, { cwd });
}

/** The branch HEAD points at, read from the file (no spawn). */
function currentBranch(): string | null {
  const head = readFileSync(join(repo, ".git", "HEAD"), "utf8").trim();
  return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : null;
}

/**
 * Commit one file onto `branch`. Each git spawn costs 0.3-1 s on a loaded Windows box and this
 * suite makes ~100 commits, so a branch that is NOT checked out is advanced with ONE
 * `fast-import` spawn instead of checkout + add + commit (#1511). The checked-out branch keeps
 * the real path, because fast-import would leave its working tree behind the ref.
 */
export async function commitFile(branch: string, name: string, content: string) {
  const msg = `feat: ${name} on ${branch}`;
  if (currentBranch() === branch) {
    writeFileSync(join(repo, name), content, "utf8");
    await git(["add", name]);
    await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", msg]);
    return;
  }
  const stream =
    `commit refs/heads/${branch}\n` +
    `committer t <t@t> ${Math.floor(Date.now() / 1000)} +0000\n` +
    `data ${Buffer.byteLength(msg)}\n${msg}\n` +
    `from refs/heads/${branch}^0\n` +
    `M 100644 inline ${name}\n` +
    `data ${Buffer.byteLength(content)}\n${content}\n`;
  await gitExecOrThrow(["fast-import", "--quiet"], { cwd: repo, input: stream });
}

// One base repo is built per FILE (call `setupTrainRepo()` at the top of a suite) and copied per test: `init` + `add` + `commit` was 3 spawns
// in front of every one of the 28 tests.
let template: string;

export function setupTrainRepo(): void {

  beforeAll(async () => {
    template = mkdtempSync(join(tmpdir(), "kanban-train-tpl-"));
    await git(["init", "-q", "-b", "main"], template);
    writeFileSync(join(template, "base.txt"), "base\n", "utf8");
    await git(["add", "."], template);
    await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "chore: base"], template);
  });

  afterAll(() => {
    try { rmSync(template, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "kanban-train-"));
    cpSync(template, repo, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  });
}
