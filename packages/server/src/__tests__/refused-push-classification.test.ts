import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { classifyRefusedPush, adoptCleanRebase, landWithRebaseAdoption, incomingRefFor } from "../services/worker-remote-sync.service.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "ak-refused-push-"));
  git(dir, "init", "-b", "master");
  writeFileSync(join(dir, "a"), "1");
  git(dir, "add", "."); git(dir, "commit", "-m", "root");
  return dir;
}

describe("classifyRefusedPush (#1427)", () => {
  it("flags a push carrying rewritten copies of base commits", async () => {
    const dir = repo();
    git(dir, "checkout", "-b", "feat");
    writeFileSync(join(dir, "b"), "2"); git(dir, "add", "."); git(dir, "commit", "-m", "base work");
    const copy = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "master");
    writeFileSync(join(dir, "z"), "z"); git(dir, "add", "."); git(dir, "commit", "-m", "diverge");
    git(dir, "cherry-pick", copy); // base has the same patch under a new hash
    git(dir, "update-ref", incomingRefFor("feat"), copy);
    const cls = await classifyRefusedPush(dir, "feat");
    expect(cls.kind).toBe("rewritten-history");
    expect(cls.summary).toContain("patch-equivalent");
  });

  it("calls a push with only its own commits a stale but clean rebase", async () => {
    const dir = repo();
    git(dir, "checkout", "-b", "feat");
    writeFileSync(join(dir, "c"), "3"); git(dir, "add", "."); git(dir, "commit", "-m", "own");
    git(dir, "update-ref", incomingRefFor("feat"), git(dir, "rev-parse", "HEAD"));
    git(dir, "checkout", "master");
    const cls = await classifyRefusedPush(dir, "feat");
    expect(cls.kind).toBe("stale-clean");
  });
});

describe("adoptCleanRebase (#1446)", () => {
  // feat has one own commit off root; master then moves on; the worker rebases feat onto it.
  function staleSetup() {
    const dir = repo();
    git(dir, "checkout", "-b", "feat");
    writeFileSync(join(dir, "c"), "3"); git(dir, "add", "."); git(dir, "commit", "-m", "own");
    git(dir, "checkout", "master");
    writeFileSync(join(dir, "z"), "z"); git(dir, "add", "."); git(dir, "commit", "-m", "base moves");
    git(dir, "checkout", "-b", "worker", "feat");
    git(dir, "rebase", "master");
    git(dir, "update-ref", incomingRefFor("feat"), git(dir, "rev-parse", "HEAD"));
    git(dir, "checkout", "master");
    return dir;
  }

  it("resets the branch to a clean rebase", async () => {
    const dir = staleSetup();
    const push = git(dir, "rev-parse", incomingRefFor("feat"));
    const out = await adoptCleanRebase(dir, "feat");
    expect(out.adopted).toBe(true);
    if (out.adopted) expect(out.summary).toContain("adopted clean rebase");
    expect(git(dir, "rev-parse", "feat")).toBe(push);
  });

  it("refuses a push whose content differs from the local branch", async () => {
    const dir = staleSetup();
    git(dir, "checkout", "worker");
    writeFileSync(join(dir, "extra"), "x"); git(dir, "add", "."); git(dir, "commit", "-m", "sneaky");
    git(dir, "update-ref", incomingRefFor("feat"), git(dir, "rev-parse", "HEAD"));
    git(dir, "checkout", "master");
    const before = git(dir, "rev-parse", "feat");
    const out = await adoptCleanRebase(dir, "feat");
    expect(out.adopted).toBe(false);
    expect(git(dir, "rev-parse", "feat")).toBe(before);
  });

  it("refuses when the worktree holding the branch is dirty", async () => {
    const dir = staleSetup();
    git(dir, "checkout", "feat");
    writeFileSync(join(dir, "c"), "dirty");
    const out = await adoptCleanRebase(dir, "feat");
    expect(out.adopted).toBe(false);
  });
});

describe("landWithRebaseAdoption (#1521)", () => {
  it("adopts a clean rebase through the shared landing rule, as incoming/land needs", async () => {
    const dir = repo();
    git(dir, "checkout", "-b", "feat");
    writeFileSync(join(dir, "c"), "3"); git(dir, "add", "."); git(dir, "commit", "-m", "own");
    git(dir, "checkout", "master");
    writeFileSync(join(dir, "z"), "z"); git(dir, "add", "."); git(dir, "commit", "-m", "base moves");
    git(dir, "checkout", "-b", "worker", "feat");
    git(dir, "rebase", "master");
    const push = git(dir, "rev-parse", "HEAD");
    git(dir, "update-ref", incomingRefFor("feat"), push);
    git(dir, "checkout", "master");
    const out = await landWithRebaseAdoption(dir, "feat");
    expect(out.outcome.ok).toBe(true);
    expect(out.adoption?.summary).toContain("adopted clean rebase");
    expect(git(dir, "rev-parse", "feat")).toBe(push);
  });

  it("still holds a push that is not a clean rebase", async () => {
    const dir = repo();
    git(dir, "checkout", "-b", "feat");
    writeFileSync(join(dir, "c"), "3"); git(dir, "add", "."); git(dir, "commit", "-m", "own");
    git(dir, "checkout", "master");
    writeFileSync(join(dir, "z"), "z"); git(dir, "add", "."); git(dir, "commit", "-m", "base moves");
    git(dir, "checkout", "-b", "worker", "master");
    writeFileSync(join(dir, "other"), "o"); git(dir, "add", "."); git(dir, "commit", "-m", "unrelated");
    git(dir, "update-ref", incomingRefFor("feat"), git(dir, "rev-parse", "HEAD"));
    git(dir, "checkout", "master");
    const before = git(dir, "rev-parse", "feat");
    const out = await landWithRebaseAdoption(dir, "feat");
    expect(out.outcome.ok).toBe(false);
    expect(git(dir, "rev-parse", "feat")).toBe(before);
  });
});
