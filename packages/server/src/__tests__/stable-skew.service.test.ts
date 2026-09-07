/**
 * Two-board skew visibility (#1055) — real git, no mocks.
 *
 * `computeStableSkew` is what makes a "Done" ticket whose fix landed on the default branch
 * but hasn't reached the operating (stable) board yet visible: it diffs the branch tip
 * against the newest `stable-*` promotion tag (`docs/two-boards.md`, `pnpm promote`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { computeStableSkew } from "../services/stable-skew.service.js";

async function git(args: string[], cwd: string): Promise<void> {
  const res = await gitExec(args, { cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.error?.message}`);
}

async function commit(repo: string, file: string, message: string): Promise<void> {
  await writeFile(join(repo, file), `${message}\n`);
  await git(["add", file], repo);
  await git(["commit", "-m", message], repo);
}

describe("computeStableSkew (#1055)", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "kanban-ak1055-"));
    await git(["init", "-b", "master"], repo);
    await git(["config", "user.email", "t@example.com"], repo);
    await git(["config", "user.name", "T"], repo);
    await commit(repo, "README.md", "initial");
  }, 60000);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  it("returns null when the repo has no stable-* tag at all", async () => {
    expect(await computeStableSkew(repo, "master")).toBeNull();
  });

  it("returns null when master is not ahead of the pinned tag", async () => {
    await git(["tag", "stable-20260901"], repo);
    expect(await computeStableSkew(repo, "master")).toBeNull();
  });

  it("reports the ahead count and picks out fix/feat-shaped commits", async () => {
    await commit(repo, "chore.txt", "chore: tidy up");
    await commit(repo, "fix.txt", "fix(#1039): heal a missing plugin skill junction live");

    const skew = await computeStableSkew(repo, "master");
    expect(skew).not.toBeNull();
    expect(skew!.stableTag).toBe("stable-20260901");
    expect(skew!.aheadCount).toBe(2);
    expect(skew!.fixShapedCount).toBe(1);
    expect(skew!.commits.map((c) => c.message)).toContain("fix(#1039): heal a missing plugin skill junction live");
    const fixCommit = skew!.commits.find((c) => c.message.startsWith("fix(#1039)"));
    expect(fixCommit?.isFixShaped).toBe(true);
    const choreCommit = skew!.commits.find((c) => c.message.startsWith("chore:"));
    expect(choreCommit?.isFixShaped).toBe(false);
  });

  it("picks the NEWEST stable-* tag when several exist (date, then same-day ordinal)", async () => {
    await git(["tag", "stable-20260905"], repo);
    await git(["tag", "stable-20260905-2"], repo);
    await commit(repo, "more.txt", "feat(#1055): surface two-board skew");

    const skew = await computeStableSkew(repo, "master");
    expect(skew!.stableTag).toBe("stable-20260905-2");
    expect(skew!.aheadCount).toBe(1);
  });
});
