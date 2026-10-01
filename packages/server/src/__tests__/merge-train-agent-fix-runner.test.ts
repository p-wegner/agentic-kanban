import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMergeQueueService } from "../services/merge-queue.service.js";
import { createMergeTrainRunner } from "../services/merge-queue-train.js";
import { listMergeTrainsForProject } from "../repositories/merge-train.repository.js";
import { resetLiveMergeTrainRegistryForTests } from "../services/merge-train-live-registry.js";
import type { TrainAgentRunner } from "../services/merge-train-agent-fix.js";

/**
 * #1277 — a red train, driven through the real runner and the real staging gate: the fix agent is
 * launched against the train's OWN gate worktree (the assembled tree, not a member's branch), its
 * commit lands with the train, and a project on `bisect` gets today's behaviour with no agent.
 * Only the agent is injected; the verify script is a node one-liner that is red while the
 * assembled tree holds `b.txt` and no `fixed.txt`.
 */
const git = (repoPath: string, args: string[]) => gitExecOrThrow(args, { cwd: repoPath });
const VERIFY_RED_ON_B_UNLESS_FIXED = `node -e "process.exit(require('fs').existsSync('b.txt')&&!require('fs').existsSync('fixed.txt')?1:0)"`;

let repoPath: string;
let db: TestDb;
let projectId: string;
let statusId: string;

async function commitOn(branch: string, file: string, content: string) {
  await git(repoPath, ["checkout", "-q", branch]);
  writeFileSync(join(repoPath, file), content, "utf8");
  await git(repoPath, ["add", file]);
  await git(repoPath, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `feat: ${file}`]);
}

let issueSeq = 7000;
async function seedWorkspace(branch: string) {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const issueNumber = issueSeq++;
  await db.insert(issues).values({ id: issueId, issueNumber, title: `Issue ${issueNumber}`, priority: "medium", sortOrder: issueNumber, statusId, projectId, createdAt: now, updatedAt: now });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch, workingDir: join(tmpdir(), "unused-workingdir", workspaceId), baseBranch: "main",
    status: "idle", isDirect: false, provider: "claude", createdAt: now, updatedAt: now,
  });
  return workspaceId;
}

async function setPref(key: string, value: string) {
  await db.insert(preferences).values({ key, value, updatedAt: new Date().toISOString() });
}

beforeEach(async () => {
  resetLiveMergeTrainRegistryForTests();
  ({ db } = createTestDb());
  repoPath = mkdtempSync(join(tmpdir(), "ak-train-agent-fix-"));
  await git(repoPath, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repoPath, "base.txt"), "base\n", "utf8");
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "chore: base"]);
  await git(repoPath, ["branch", "f1"]);
  await git(repoPath, ["branch", "f2"]);
  await commitOn("f1", "a.txt", "a\n");
  await commitOn("f2", "b.txt", "b\n");
  await git(repoPath, ["checkout", "-q", "main"]);

  const now = new Date().toISOString();
  projectId = randomUUID();
  statusId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "Test Project", repoPath, repoName: "repo", defaultBranch: "main", createdAt: now, updatedAt: now });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Review", sortOrder: 0, isDefault: true, createdAt: now });
  await setPref(`verify_script_${projectId}`, VERIFY_RED_ON_B_UNLESS_FIXED);
});

afterEach(() => {
  try { rmSync(repoPath, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function runTrain(agentFixRunner: TrainAgentRunner) {
  const a = await seedWorkspace("f1");
  const b = await seedWorkspace("f2");
  const runner = createMergeTrainRunner({
    database: db,
    reconcileAlreadyMerged: async () => {},
    sendTurn: async () => ({ type: "sent" }),
    agentFixRunner,
  });
  const service = createMergeQueueService({ database: db });
  const events = [];
  for await (const event of runner.runTrainStrategy(await service.computePlan([a, b]))) events.push(event);
  const [train] = await listMergeTrainsForProject(projectId, db);
  return { events, train, evidence: JSON.parse(train.gateEvidence ?? "{}") as { attempts?: Array<{ label: string; verdict: string; kind?: string }>; redStrategy?: string; landed?: string[] } };
}

describe("merge train red -> fix agent (#1277)", () => {
  it("launches the agent against the assembled gate worktree and lands its fix", async () => {
    const seen: { worktree: string; hadA: boolean; hadB: boolean; prompt: string }[] = [];
    const agent: TrainAgentRunner = vi.fn(async ({ worktree, prompt }) => {
      seen.push({ worktree, hadA: existsSync(join(worktree, "a.txt")), hadB: existsSync(join(worktree, "b.txt")), prompt });
      writeFileSync(join(worktree, "fixed.txt"), "fixed\n", "utf8");
      return {};
    });

    const { events, train, evidence } = await runTrain(agent);

    // One agent, in a tree holding BOTH members' work, under the train namespace — never a member's worktree or the repo.
    expect(agent).toHaveBeenCalledTimes(1);
    expect(seen[0].hadA && seen[0].hadB).toBe(true);
    expect(seen[0].worktree).not.toBe(repoPath);
    expect(seen[0].worktree.replace(/\\/g, "/")).toContain("/train/");
    expect(seen[0].prompt).toContain("Make the failing suite(s) pass");

    expect(events.filter((e) => e.type === "merged")).toHaveLength(2);
    expect(train.state).toBe("landed");
    expect(evidence.redStrategy).toBe("agent-fix-then-bisect");
    expect(evidence.attempts?.map((a) => [a.kind ?? "gate", a.verdict])).toEqual([["agent_fix", "agent_fix_green"], ["gate", "landed"]]);
    // The agent's commit is on main with the members.
    expect(await git(repoPath, ["show", "main:fixed.txt"])).toContain("fixed");
    expect(await git(repoPath, ["show", "main:b.txt"])).toContain("b");
  }, 180000);

  it("a cap trip (agent timed out) falls back to the bisect, and both are on the train", async () => {
    // Red only with b.txt present and no fix: the bisect lands f1 and rejects f2.
    const agent: TrainAgentRunner = vi.fn(async () => { throw new Error("timed out after 5ms (killed with SIGTERM)"); });

    const { events, evidence } = await runTrain(agent);

    expect(agent).toHaveBeenCalledTimes(1);
    const verdicts = evidence.attempts?.map((a) => a.verdict) ?? [];
    expect(verdicts[0]).toBe("agent_fix_capped");
    expect(verdicts).toEqual(expect.arrayContaining(["red", "landed"]));
    expect(events.filter((e) => e.type === "merged")).toHaveLength(1);
    expect(events.some((e) => e.type === "error")).toBe(true);
  }, 240000);

  it("`merge_train_red_strategy_<id> = bisect` never launches the agent", async () => {
    await setPref(`merge_train_red_strategy_${projectId}`, "bisect");
    const agent: TrainAgentRunner = vi.fn(async () => ({}));

    const { evidence } = await runTrain(agent);

    expect(agent).not.toHaveBeenCalled();
    expect(evidence.redStrategy).toBe("bisect");
    expect(evidence.attempts?.some((a) => a.kind === "agent_fix")).toBe(false);
  }, 240000);

  it("`agent-fix` alone: a failed fix fails the train without a bisect", async () => {
    await setPref(`merge_train_red_strategy_${projectId}`, "agent-fix");
    const agent: TrainAgentRunner = vi.fn(async () => { throw new Error("exited 1"); });

    const { events, train, evidence } = await runTrain(agent);

    expect(agent).toHaveBeenCalledTimes(1);
    expect(train.state).toBe("red");
    expect(events.filter((e) => e.type === "merged")).toHaveLength(0);
    expect(evidence.attempts?.map((a) => a.verdict)).toEqual(["agent_fix_red", "red"]);
  }, 240000);
});
