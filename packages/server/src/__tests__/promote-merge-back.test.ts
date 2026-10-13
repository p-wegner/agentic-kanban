// @gate:always-run when:scripts/promote-merge-back.mjs — imports scripts/promote-merge-back.mjs, which no package-local diff links to (#687).
/** #1436: a healed rc is merged back into master by `pnpm promote`, reported, and re-probed. */
import { describe, expect, it, vi } from "vitest";
import { mergeBackRc } from "../../../../scripts/promote-merge-back.mjs";

type R = { code: number; stdout: string; stderr: string };
const ok = (stdout = ""): R => ({ code: 0, stdout, stderr: "" });
const bad = (stderr = "boom"): R => ({ code: 1, stdout: "", stderr });

function setup(over: Record<string, R> = {}, ws: unknown = null) {
  const calls: string[] = [];
  const logs: string[] = [];
  const table: Record<string, R> = {
    "merge-base": ok(),
    "rev-list": ok("3"),
    "symbolic-ref": ok("master"),
    status: ok(""),
    merge: ok(),
    "rev-parse": ok("abc1234"),
    ...over,
  };
  const deps = {
    rcBranch: "rc/20261013",
    baseBranch: "master",
    tag: "stable-20261013-2",
    git: (a: string[]) => {
      calls.push(a[0] === "merge" ? `merge ${a[1]}` : a[0]);
      return table[a[0]] ?? ok();
    },
    requestWorkspace: vi.fn(async () => ws as never),
    reprobe: vi.fn(async () => true),
    markAttention: vi.fn(async () => {}),
    log: (l: string) => logs.push(l),
  };
  return { deps, calls, logs };
}

describe("mergeBackRc", () => {
  it("does nothing when the rc tip is already in master", async () => {
    const { deps, logs } = setup();
    expect((await mergeBackRc(deps)).outcome).toBe("nothing");
    expect(logs.join("\n")).toContain("no merge-back needed");
    expect(deps.reprobe).not.toHaveBeenCalled();
  });

  it("merges a healed rc, logs the count and sha, and re-probes master", async () => {
    const { deps, logs } = setup({ "merge-base": bad("") });
    const res = await mergeBackRc(deps);
    expect(res).toEqual({ outcome: "merged", count: 3, sha: "abc1234" });
    expect(logs.join("\n")).toContain("merged back 3 commit(s) into master @ abc1234");
    expect(deps.reprobe).toHaveBeenCalledOnce();
  });

  it("aborts a conflicting merge and falls back to a board workspace", async () => {
    const { deps, calls } = setup({ "merge-base": bad(""), merge: bad("CONFLICT") }, { issueNumber: 9, workspaceId: "w", created: true });
    expect((await mergeBackRc(deps)).outcome).toBe("workspace");
    expect(calls).toContain("merge --abort");
  });

  it("fails loudly and marks attention when nothing worked", async () => {
    const { deps, logs } = setup({ "merge-base": bad(""), "symbolic-ref": ok("feature/x") });
    const res = await mergeBackRc(deps);
    expect(res.outcome).toBe("failed");
    expect(logs.join("\n")).toContain("MERGE-BACK FAILED");
    expect(deps.markAttention).toHaveBeenCalledOnce();
  });
});
