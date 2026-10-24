import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { applyWorkerFix } from "../services/claude-oneshot-worker.service.js";

// #1711: the host train tree is left mid-merge (MERGE_HEAD, unmerged index) when a member merge
// conflicts; the worker's resolution must still be fast-forwarded in.
describe("applyWorkerFix with a conflicting member merge left open (#1711)", () => {
  let dir: string;
  const g = (args: string[]) =>
    gitExecOrThrow(["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir });
  const write = (n: string, c: string) => writeFileSync(join(dir, n), c, "utf8");

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ak-1711-"));
    await g(["init", "-q", "-b", "train"]);
    write("f.txt", "base\n");
    await g(["add", "."]);
    await g(["commit", "-q", "-m", "base"]);
    await g(["branch", "member"]);
    write("f.txt", "train\n");
    await g(["commit", "-qam", "train change"]);
    await g(["checkout", "-q", "member"]);
    write("f.txt", "member\n");
    await g(["commit", "-qam", "member change"]);
    await g(["checkout", "-q", "train"]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function head() {
    return String(await g(["rev-parse", "HEAD"])).trim();
  }

  it("aborts the open merge, then fast-forwards the worker's fix", async () => {
    const pre = await head();
    await gitExecOrThrow(["merge", "member"], { cwd: dir }).catch(() => undefined);
    // the worker resolves on the pre-merge head and pushes a merge commit
    await g(["merge", "--abort"]);
    await gitExecOrThrow(["merge", "member"], { cwd: dir }).catch(() => undefined);
    write("f.txt", "resolved\n");
    await g(["add", "f.txt"]);
    await g(["commit", "-qm", "resolution"]);
    const fix = await head();
    await g(["update-ref", "refs/fix", fix]);
    await g(["reset", "-q", "--hard", pre]);
    await gitExecOrThrow(["merge", "member"], { cwd: dir }).catch(() => undefined); // open conflicted merge again

    await applyWorkerFix(dir, fix, undefined, pre);
    expect(await head()).toBe(fix);
  });

  it("refuses a fix that is not built on the pre-merge head", async () => {
    const pre = await head();
    await g(["checkout", "-q", "--orphan", "other"]);
    write("o.txt", "x\n");
    await g(["add", "o.txt"]);
    await g(["commit", "-qm", "unrelated"]);
    const stray = await head();
    await g(["checkout", "-q", "-f", "train"]);
    await expect(applyWorkerFix(dir, stray, undefined, pre)).rejects.toThrow(/not built on/);
  });
});
