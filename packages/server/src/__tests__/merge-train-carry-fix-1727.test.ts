import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { applyCarriedFix, clearCarriedFix, pinCarriedFix, readCarriedFix, withCarriedFix } from "../services/merge-train-carry-fix.js";
import { INCONCLUSIVE_ABANDON_MARKER, isInconclusiveRetry } from "../services/merge-queue-train-inconclusive.js";
import { decideMergeTrainRelease } from "../services/merge-train-window.js";

let repo = "";
const git = (args: string[]) => gitExecOrThrow(["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo });

async function commitFile(name: string, body: string, msg: string): Promise<string> {
  writeFileSync(join(repo, name), body, "utf8");
  await git(["add", "."]);
  await git(["commit", "-q", "-m", msg]);
  return (await git(["rev-parse", "HEAD"])).trim();
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "kanban-train-carry-"));
  await git(["init", "-q", "-b", "main"]);
  await commitFile("base.txt", "base\n", "chore: base");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("carried shepherd fix (#1727)", () => {
  it("re-applies a pinned fix onto a re-formed train and logs the carried commit", async () => {
    const baseSha = (await git(["rev-parse", "HEAD"])).trim();
    // the abandoned train: base + fix commit
    await git(["checkout", "-q", "-b", "old-train"]);
    const tipSha = await commitFile("guard.txt", "fixed\n", "fix: satisfy the guards");
    await git(["checkout", "-q", "main"]);
    // the re-formed train: a different member commit, no fix
    await git(["checkout", "-q", "-b", "kanban/train/new"]);
    const trainSha = await commitFile("member.txt", "m\n", "feat: member");
    await git(["checkout", "-q", "main"]);

    const members = ["w2", "w1"];
    expect(await pinCarriedFix({ repoPath: repo, memberWorkspaceIds: members, label: "train/x", baseSha, tipSha })).toContain("satisfy the guards");
    await git(["branch", "-D", "old-train"]);

    const carried = await readCarriedFix(repo, ["w1", "w2"]);
    expect(carried).toEqual({ baseSha, tipSha });
    const res = await applyCarriedFix({ repoPath: repo, trainRef: "kanban/train/new", trainSha, label: "train/new", carried: carried! });
    expect(res.applied).toBe(true);
    expect(res.log).toContain("satisfy the guards");
    expect((await git(["rev-parse", "kanban/train/new"])).trim()).toBe((res as { newSha: string }).newSha);
    expect(await git(["show", "kanban/train/new:guard.txt"])).toBe("fixed\n");
    expect(await git(["show", "kanban/train/new:member.txt"])).toBe("m\n");

    await clearCarriedFix(repo, members);
    expect(await readCarriedFix(repo, members)).toBeNull();
  });

  it("gates uncarried (and says so) when the fix conflicts", async () => {
    const baseSha = (await git(["rev-parse", "HEAD"])).trim();
    await git(["checkout", "-q", "-b", "old"]);
    const tipSha = await commitFile("base.txt", "fixed\n", "fix: x");
    await git(["checkout", "-q", "main"]);
    await git(["checkout", "-q", "-b", "kanban/train/new"]);
    const trainSha = await commitFile("base.txt", "different\n", "feat: other");
    const res = await applyCarriedFix({ repoPath: repo, trainRef: "kanban/train/new", trainSha, label: "train/new", carried: { baseSha, tipSha } });
    expect(res.applied).toBe(false);
    expect(res.log).toContain("gating without it");
    expect((await git(["rev-parse", "kanban/train/new"])).trim()).toBe(trainSha);
  });

  it("withCarriedFix carries once on the root attempt only and records the pre-carry sha", async () => {
    const baseSha = (await git(["rev-parse", "HEAD"])).trim();
    await git(["checkout", "-q", "-b", "old"]);
    const tipSha = await commitFile("guard.txt", "fixed\n", "fix: guards");
    await git(["checkout", "-q", "main"]);
    await git(["checkout", "-q", "-b", "kanban/train/r"]);
    const trainSha = await commitFile("member.txt", "m\n", "feat: member");
    await git(["checkout", "-q", "main"]);
    await pinCarriedFix({ repoPath: repo, memberWorkspaceIds: ["w1"], label: "r", baseSha, tipSha });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const state: { preCarrySha?: string } = {};
    const inner = async () => ({ trainRef: "kanban/train/r", trainSha });
    const wrapped = withCarriedFix(inner, "r", state);
    const half = await wrapped({ repoPath: repo, label: "ra", members: [{ workspaceId: "w1" }] });
    expect(half.trainSha).toBe(trainSha);
    const root = await wrapped({ repoPath: repo, label: "r", members: [{ workspaceId: "w1" }] });
    expect(root.trainSha).not.toBe(trainSha);
    expect(state.preCarrySha).toBe(trainSha);
  });
});

describe("inconclusive abandon re-departs at once (#1727)", () => {
  const abandoned = { state: "abandoned", reconciledReason: `${INCONCLUSIVE_ABANDON_MARKER}: worker_unreachable`, memberWorkspaceIds: JSON.stringify(["a", "b"]) };

  it("recognises the same members after an inconclusive abandon", () => {
    expect(isInconclusiveRetry(["a", "b"], [abandoned])).toBe(true);
    expect(isInconclusiveRetry(["a"], [abandoned])).toBe(true);
  });

  it("ignores other members, other abandon reasons and a newer finished train", () => {
    expect(isInconclusiveRetry(["a", "c"], [abandoned])).toBe(false);
    expect(isInconclusiveRetry(["a"], [{ ...abandoned, reconciledReason: "gate-age-ceiling" }])).toBe(false);
    expect(isInconclusiveRetry(["a"], [{ state: "red", memberWorkspaceIds: abandoned.memberWorkspaceIds }, abandoned])).toBe(false);
    expect(isInconclusiveRetry([], [abandoned])).toBe(false);
  });

  it("releases on the first tick, with no wait elapsed", () => {
    const now = Date.now();
    const state = { pendingIds: ["a", "b"], firstSeenAt: new Date(now).toISOString() };
    const config = { maxSize: 10, maxWaitMs: 30 * 60_000 } as never;
    expect(decideMergeTrainRelease(state, config, now, {}).release).toBe(false);
    expect(decideMergeTrainRelease(state, config, now, { inconclusiveRetry: true })).toEqual({ release: true, reason: "inconclusive_retry" });
  });
});
