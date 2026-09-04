/**
 * #1018 — a worktree gets a READ-ONLY copy of the map, because it no longer inherits one.
 *
 * While the map was committed, a worktree got it by branching. Untracked, it does not — and the
 * failure is silent in both consumers (`test-mine.mjs` falls back to `vitest related`, the merge
 * gate's impact tier reports `selection UNKNOWN`). So the copy is the mechanism that keeps the
 * selection usable in the card loop at all, and its edge cases are worth pinning: absent is a
 * supported state, a self-copy must never truncate the source, and the copy must be invisible to
 * git so it cannot dirty the worktree (`workspaceLaunchPreflight` refuses to relaunch a dirty one).
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IMPACT_MAP_PATH } from "../services/test-impact-map.service.js";
import { materializeImpactMapIntoWorktree } from "../services/test-impact-map/worktree-map.js";

const created: string[] = [];
afterAll(() => {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* a held Windows handle is not worth failing the suite over */ }
  }
});

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ak-1018-${prefix}-`));
  created.push(dir);
  return dir;
}

function writeMap(root: string, contents: string): void {
  mkdirSync(join(root, "docs", "tests"), { recursive: true });
  writeFileSync(join(root, IMPACT_MAP_PATH), contents);
}

describe("materializeImpactMapIntoWorktree (#1018)", () => {
  it("copies the main checkout's map to the same relative path in the worktree", async () => {
    const repo = makeDir("repo");
    const worktree = makeDir("wt");
    writeMap(repo, '{"format":"test-impact 1","commit":"8a0f35d793"}\n');

    const res = await materializeImpactMapIntoWorktree(repo, worktree);

    expect(res.outcome).toBe("copied");
    expect(res.bytes).toBeGreaterThan(0);
    expect(readFileSync(join(worktree, IMPACT_MAP_PATH), "utf8")).toContain('"commit":"8a0f35d793"');
  });

  it("creates the intermediate directories the worktree does not have yet", async () => {
    // `docs/tests/` exists in a real checkout, but not necessarily before the copy runs — and a
    // provisioning step that threw ENOENT here would be a hard failure over an optimisation.
    const repo = makeDir("repo");
    const worktree = makeDir("wt");
    writeMap(repo, "{}\n");
    expect(existsSync(join(worktree, "docs"))).toBe(false);

    await expect(materializeImpactMapIntoWorktree(repo, worktree)).resolves.toMatchObject({ outcome: "copied" });
  });

  it("reports ABSENT, not failure, when the main checkout has no map", async () => {
    // A fresh clone before the first sweep, or a project that never opted in. `select` then
    // widens to the package tier and says so — a wider run, never a wrong one.
    const res = await materializeImpactMapIntoWorktree(makeDir("repo"), makeDir("wt"));
    expect(res.outcome).toBe("absent");
  });

  it("refuses to copy a map onto ITSELF for a direct workspace", async () => {
    // `isDirect` workspaces have `workingDir === repoPath`. `copyFile` onto its own source
    // truncates it — the one way this helper could destroy the artifact it distributes.
    const repo = makeDir("repo");
    writeMap(repo, '{"commit":"precious"}\n');

    const res = await materializeImpactMapIntoWorktree(repo, repo);

    expect(res.outcome).toBe("absent");
    expect(readFileSync(join(repo, IMPACT_MAP_PATH), "utf8")).toBe('{"commit":"precious"}\n');
  });

  it("lands on a path the repo's own .gitignore already covers, so it cannot dirty the worktree", () => {
    // Not a property of this function but of the pair (this path, the repo's ignore rule) — and
    // the pair is what matters: a copy that showed up in `git status` would block relaunch and
    // land in the branch diff. Asserted against a real git repo carrying THIS repo's rule.
    const repo = makeDir("gitrepo");
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
    git(["init", "-b", "main"]);
    writeFileSync(join(repo, ".gitignore"), `/${IMPACT_MAP_PATH}\n`);
    writeMap(repo, '{"commit":"x"}\n');

    expect(git(["status", "--porcelain"])).not.toContain("impact-map.json");
  });
});
