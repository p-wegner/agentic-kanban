import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { isAncestor, revParse } from "@agentic-kanban/shared/lib/git-service";
import { runMergeTrain } from "../services/merge-train.service.js";

/**
 * #1181 — a train job keeps running after its `merge_trains` row is marked `abandoned`
 * (operator cancel, or the reconciler's verdict on a row it wrongly took for stranded); there
 * is no cancellation token into `runMergeTrain`. Measured 2026-09-16: the 23:13 train's job
 * was still gating and heart-beating the repo lock at 23:56, fifteen minutes after its row was
 * abandoned. The gate work is sunk cost, but the LANDING is not: a train nobody accounts for
 * must not move the base. `shouldLand` is asked once, after a green gate, right before
 * `landMergeTrain`.
 */
let repo: string;

async function git(args: string[], cwd = repo) {
  return gitExecOrThrow(args, { cwd });
}

async function commitFile(branch: string, name: string, content: string) {
  await git(["checkout", "-q", branch]);
  writeFileSync(join(repo, name), content, "utf8");
  await git(["add", name]);
  await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `feat: ${name} on ${branch}`]);
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "kanban-train-veto-"));
  await git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
  await git(["add", "."]);
  await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "chore: base"]);
  await git(["branch", "f1"]);
  await git(["branch", "f2"]);
  await commitFile("f1", "a.txt", "a\n");
  await commitFile("f2", "b.txt", "b\n");
  await git(["checkout", "-q", "main"]);
});

afterEach(() => {
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("runMergeTrain shouldLand veto (#1181)", () => {
  it("does not land a green train whose row was abandoned mid-gate, and does not bisect it", async () => {
    const baseBefore = await revParse(repo, "main");
    let gateRuns = 0;
    let asked = 0;

    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [{ workspaceId: "w1", branch: "f1" }, { workspaceId: "w2", branch: "f2" }],
      label: "t-veto",
      runGate: async () => { gateRuns++; return { passed: true, message: "ok" }; },
      closeMember: async () => { throw new Error("must not close a member that did not land"); },
      shouldLand: async () => { asked++; return "row abandoned while gating"; },
    });

    expect(asked).toBe(1);
    expect(gateRuns).toBe(1);
    expect(result.landed).toEqual([]);
    expect(result.gateRejected).toEqual([]);
    expect(result.landRefused).toBe("row abandoned while gating");
    expect(result.gateFailure).toBe("row abandoned while gating");
    expect(result.gateRuns).toBe(1);
    expect(await revParse(repo, "main")).toBe(baseBefore);
    expect(await isAncestor(repo, "f1", "main")).toBe(false);
    // The scratch ref is still cleaned up on this exit.
    await expect(revParse(repo, result.trainRef)).rejects.toBeTruthy();
  });

  it("lands when shouldLand returns null (control)", async () => {
    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [{ workspaceId: "w1", branch: "f1" }, { workspaceId: "w2", branch: "f2" }],
      label: "t-ok",
      runGate: async () => ({ passed: true, message: "ok" }),
      closeMember: async () => {},
      shouldLand: async () => null,
    });
    expect(result.landed.map((m) => m.branch).sort()).toEqual(["f1", "f2"]);
    expect(result.landRefused).toBeUndefined();
    expect(await isAncestor(repo, "f1", "main")).toBe(true);
  });

  it("is not asked when the gate is red — nothing was going to land anyway", async () => {
    let asked = 0;
    const result = await runMergeTrain({
      repoPath: repo,
      baseBranch: "main",
      members: [{ workspaceId: "w1", branch: "f1" }],
      label: "t-red",
      bisectOnFailure: false,
      runGate: async () => ({ passed: false, message: "verify failed" }),
      closeMember: async () => {},
      shouldLand: async () => { asked++; return null; },
    });
    expect(asked).toBe(0);
    expect(result.landed).toEqual([]);
  });
});
