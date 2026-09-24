/**
 * #1233 — the red-base veto is posture-aware. Measured 2026-09-24: a red nightly sweep under
 * `iterate` (then `redBasePolicy: block`) held the dev board's train window, and since the base
 * only moves through trains the project froze until a human hand-landed a fix on the base — and
 * `block` also files no heal ticket, so nothing on the board said why.
 *
 * The window half is driven end to end through the REAL `resolveBaseRedVeto` (no injected
 * verdict): a red `base_branch_health` row, four ready workspaces, and the project's posture
 * set through the pref the resolver reads. Under `iterate` the window departs; under `standard`
 * it holds exactly as #1204 built it. The delivery read model is asserted from the same rows,
 * so the chip and the orchestrator can never disagree about whether a red base is holding.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseBranchHealth, issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { invalidatePreferencesCache } from "../repositories/preferences.repository.js";
import { createAutoMergeOrchestrator } from "../startup/auto-merge-orchestrator.js";
import { getDeliveryStatus } from "../services/delivery-status.service.js";
import { resolveBaseRedVeto } from "../services/merge-train-base-veto.js";
import { riskPosturePrefKey } from "../services/risk-posture.service.js";

type Db = ReturnType<typeof createTestDb>["db"];

const RED_SHA = "0".repeat(40);

async function seedRedProject(db: Db, level: "standard" | "iterate" | "strict" | "flow") {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  // A repo path that does not exist: the tip cannot be read, so the base is not known to have
  // moved past the red sha and the ONLY thing deciding the hold is the policy.
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: join(tmpdir(), "kanban-no-such-repo-1233"), repoName: "repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "AI Reviewed", sortOrder: 0, isDefault: false, createdAt: now,
  });
  for (let i = 0; i < 4; i++) {
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(issues).values({
      id: issueId, issueNumber: i + 1, title: "I", priority: "medium", sortOrder: i,
      statusId, projectId, createdAt: now, updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch: `feature/${workspaceId}`, workingDir: `/tmp/wt/${workspaceId}`,
      baseBranch: "main", isDirect: false, status: "idle", readyForMerge: true, provider: "claude",
      createdAt: now, updatedAt: now,
    });
  }
  await db.insert(baseBranchHealth).values({
    id: randomUUID(), projectId, sha: RED_SHA, branch: "main", outcome: "red",
    message: "4 guard suites failed", createdAt: now,
  });
  await db.insert(preferences).values({ key: riskPosturePrefKey(projectId), value: level, updatedAt: now });
  invalidatePreferencesCache();
  return projectId;
}

describe("the train window's red-base veto reads the risk posture (#1233)", () => {
  it("departs on a red base under `iterate` — the sweep files a heal ticket instead of holding", async () => {
    const { db } = createTestDb();
    const projectId = await seedRedProject(db, "iterate");

    await expect(resolveBaseRedVeto(projectId, db)).resolves.toBeNull();

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    const rows = await orchestrator.findCompletedWorkspaceRows();
    const released = await orchestrator.applyTrainWindow(rows, new Date().toISOString());
    expect(released).toHaveLength(4);
    expect(orchestrator.state.trainWindows.get(projectId)).toBeUndefined();

    const delivery = await getDeliveryStatus(projectId, db);
    expect(delivery.redBase).toMatchObject({
      policy: "allow-file-debt-ticket", latestOutcome: "red", latestSha: RED_SHA, holdingWindow: false, openHealTickets: 0,
    });
  });

  it("departs on a red base under `flow` (#1240) — `report` never holds and files no heal ticket", async () => {
    const { db } = createTestDb();
    const projectId = await seedRedProject(db, "flow");

    await expect(resolveBaseRedVeto(projectId, db)).resolves.toBeNull();

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    const rows = await orchestrator.findCompletedWorkspaceRows();
    const released = await orchestrator.applyTrainWindow(rows, new Date().toISOString());
    expect(released).toHaveLength(4);
    expect(orchestrator.state.trainWindows.get(projectId)).toBeUndefined();

    const delivery = await getDeliveryStatus(projectId, db);
    expect(delivery.redBase).toMatchObject({
      policy: "report", latestOutcome: "red", latestSha: RED_SHA, holdingWindow: false, openHealTickets: 0,
    });
    // And the delivery view says where the full suite runs instead of naming a cadence.
    expect(delivery.baseSweep).toMatchObject({ scheduled: false, intervalMs: null, nominalIntervalMs: null, postureLevel: "flow" });
    expect(delivery.baseSweep.reason).toContain("full suite: release candidate only");
  });

  it("holds on a red base under `standard`, exactly as #1204 built it", async () => {
    const { db } = createTestDb();
    const projectId = await seedRedProject(db, "standard");

    await expect(resolveBaseRedVeto(projectId, db)).resolves.toMatchObject({ healthSha: RED_SHA });

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    const rows = await orchestrator.findCompletedWorkspaceRows();
    const released = await orchestrator.applyTrainWindow(rows, new Date().toISOString());
    expect(released).toEqual([]);
    const window = orchestrator.state.trainWindows.get(projectId);
    expect(window?.lastVerdict).toEqual({ release: false, reason: "base_red" });
    expect(window?.pendingIds).toHaveLength(4);

    const delivery = await getDeliveryStatus(projectId, db);
    expect(delivery.redBase).toMatchObject({ policy: "block", latestOutcome: "red", holdingWindow: true });
  });

  it("strict holds too — `block` stays the policy for standard and strict", async () => {
    const { db } = createTestDb();
    const projectId = await seedRedProject(db, "strict");
    await expect(resolveBaseRedVeto(projectId, db)).resolves.toMatchObject({ healthSha: RED_SHA });
  });

  it("a caller-supplied posture wins over the pref read, so the orchestrator's one resolution is the one used", async () => {
    const { db } = createTestDb();
    const projectId = await seedRedProject(db, "standard");
    const iterateLike = { redBasePolicy: "allow-file-debt-ticket", level: "iterate", source: "risk_posture" };
    await expect(resolveBaseRedVeto(projectId, db, { posture: iterateLike as never })).resolves.toBeNull();
  });
});
