import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveMergeTrainRedPolicy } from "@agentic-kanban/shared/lib/merge-train-red-strategy";
import { createRoutes } from "../routes/index.js";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import { createTrainShepherdKit } from "../services/merge-train-shepherd-wiring.js";
import type { TrainAgentRunner } from "../services/merge-train-agent-fix.js";
import type { TrainMember } from "../services/merge-train-assembly.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
const PID = "0b3f1a2c-4d5e-6789-abcd-ef0123456789";
const key = `merge_train_conflict_resolution_${PID}`;

describe("merge_train_conflict_resolution setting (#1711)", () => {
  const { app } = _createTestApp((a, db) => { a.route("/api", createRoutes(db, () => createMockSessionManager())); });

  it("round-trips through PUT /api/preferences/settings and defaults to shepherd", async () => {
    expect(resolveMergeTrainRedPolicy(new Map(), PID).conflictResolution).toBe("shepherd");
    for (const value of ["defer", "author", "shepherd"]) {
      const put = await app.request("/api/preferences/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [key]: value }),
      });
      expect(put.status).toBe(200);
      const got = await (await app.request("/api/preferences/settings")).json() as Record<string, string>;
      expect(got[key]).toBe(value);
      expect(resolveMergeTrainRedPolicy(new Map(Object.entries(got)), PID).conflictResolution).toBe(value);
    }
  });

  it("an unknown value falls back to the shepherd", () => {
    expect(resolveMergeTrainRedPolicy(new Map([[key, "nonsense"]]), PID).conflictResolution).toBe("shepherd");
  });
});

describe("train assembly honours the setting for a conflicting pair (#1711)", () => {
  let root: string;
  let repo: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ak-train-conflict-res-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "f.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(repo, "g.txt"), "g1\ng2\ng3\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    for (const [name, file, content] of [["feature/1", "f.txt", "one\nTWO-1\nthree\n"], ["feature/2", "f.txt", "one\nTWO-2\nthree\n"], ["feature/3", "g.txt", "g1\ng2\nG3\n"]]) {
      git(repo, "checkout", "-q", "-b", name, "main");
      writeFileSync(join(repo, file), content);
      git(repo, "commit", "-qam", name);
    }
    git(repo, "checkout", "-q", "main");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const members: TrainMember[] = [1, 2, 3].map((n) => ({ workspaceId: `w${n}`, branch: `feature/${n}`, issueNumber: n }));
  const { db } = _createTestApp(() => undefined);

  /** A fixture shepherd turn, as a worker would run it: from the clean tree, merge the named branch and resolve it. */
  const turns: string[] = [];
  const runner: TrainAgentRunner = async (a) => {
    turns.push(a.prompt);
    const branch = /git merge --no-ff ([^\s`]+)/.exec(a.prompt)?.[1] as string;
    try { git(a.worktree, "-c", "user.email=s@s", "-c", "user.name=s", "merge", "--no-ff", "-q", branch); } catch { /* conflict */ }
    writeFileSync(join(a.worktree, "f.txt"), "one\nTWO-1\nTWO-2\nthree\n");
    git(a.worktree, "add", "f.txt");
    git(a.worktree, "-c", "user.email=s@s", "-c", "user.name=s", "commit", "--no-edit", "-q");
    return { sessionId: "s1", worker: "desktop-stable" };
  };
  const assembleWith = async (value: string | undefined, label: string) => {
    turns.length = 0;
    const policy = resolveMergeTrainRedPolicy(new Map(value ? [[key, value]] : []), PID);
    const kit = createTrainShepherdKit({ database: db as never, agentRunner: runner, policy, trainId: "t", projectId: PID, label, members });
    const res = await kit.assemble({ repoPath: repo, baseBranch: "main", members, label });
    await kit.flush();
    return res;
  };

  it("shepherd (default): the conflict turn runs and the train carries both members", async () => {
    const res = await assembleWith(undefined, "train/c-01");
    expect(turns).toHaveLength(1);
    expect(res.included.map((m) => m.workspaceId).sort()).toEqual(["w1", "w2", "w3"]);
    expect(res.dropped).toEqual([]);
    expect(git(repo, "show", `${res.trainRef}:f.txt`)).toContain("TWO-2");
  });

  it("defer: the later member waits for the next train, no turn", async () => {
    const res = await assembleWith("defer", "train/c-02");
    expect(turns).toHaveLength(0);
    expect(res.included).toHaveLength(2);
    expect(res.dropped).toHaveLength(1);
    expect(res.dropped[0].deferred).toBe(true);
  });

  it("author: the conflicting member is dropped for its author (not deferred), no turn", async () => {
    const res = await assembleWith("author", "train/c-03");
    expect(turns).toHaveLength(0);
    expect(res.included).toHaveLength(2);
    expect(res.dropped).toHaveLength(1);
    expect(res.dropped[0].deferred).toBeUndefined();
  });

  it("a shepherd turn that does not resolve falls back to defer for that member, never a drop", async () => {
    const kit = createTrainShepherdKit({
      database: db as never, agentRunner: async () => ({}), trainId: "t", projectId: PID, label: "train/c-04", members,
      policy: resolveMergeTrainRedPolicy(new Map(), PID),
    });
    const res = await kit.assemble({ repoPath: repo, baseBranch: "main", members, label: "train/c-04" });
    expect(res.dropped).toHaveLength(1);
    expect(res.dropped[0]).toMatchObject({ deferred: true });
    expect(res.dropped[0].reason).toMatch(/deferred to the next train/);
  });
});
