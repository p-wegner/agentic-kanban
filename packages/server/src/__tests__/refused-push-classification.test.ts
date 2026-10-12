import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { classifyRefusedPush, incomingRefFor } from "../services/worker-remote-sync.service.js";

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
