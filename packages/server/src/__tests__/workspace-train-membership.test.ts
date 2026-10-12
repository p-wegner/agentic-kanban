import { afterEach, describe, expect, it } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import { seedIssue, seedProject, seedWorkspace } from "./helpers/workflow-test-helpers.js";
import { createMergeTrain, updateMergeTrainState } from "../repositories/merge-train.repository.js";
import { registerLiveMergeTrain, resetLiveMergeTrainRegistryForTests } from "../services/merge-train-live-registry.js";
import { assertNotInLiveTrain } from "../services/workspace-train-membership.service.js";

/** #1418 — a launch/send-back must not move a live train member's branch under the train. */
async function seed() {
  const { db } = createTestDb();
  const { projectId, statusId } = await seedProject(db, "p1418");
  const issueId = await seedIssue(db, projectId, statusId, 1, "t");
  const workspaceId = await seedWorkspace(db, issueId, "feature/ak-1-x", null);
  await createMergeTrain({ id: "train-1", projectId, label: "train/2026-10-12-06", memberWorkspaceIds: [workspaceId] }, db);
  await updateMergeTrainState("train-1", { state: "gating" }, db);
  return { db, projectId, workspaceId };
}

describe("assertNotInLiveTrain (#1418)", () => {
  afterEach(() => resetLiveMergeTrainRegistryForTests());

  it("refuses a launch on a member of a live train, naming the train", async () => {
    const { db, projectId, workspaceId } = await seed();
    registerLiveMergeTrain({ trainId: "train-1", label: "train/2026-10-12-06", projectId });
    await expect(assertNotInLiveTrain(db, workspaceId, "launch")).rejects.toThrow(/train\/2026-10-12-06/);
  });

  it("allows it when the train row is active but no job is live (stranded row)", async () => {
    const { db, workspaceId } = await seed();
    await expect(assertNotInLiveTrain(db, workspaceId, "launch")).resolves.toBeUndefined();
  });

  it("allows it once the train is terminal", async () => {
    const { db, projectId, workspaceId } = await seed();
    registerLiveMergeTrain({ trainId: "train-1", label: "train/2026-10-12-06", projectId });
    await updateMergeTrainState("train-1", { state: "landed", finishedAt: new Date().toISOString() }, db);
    await expect(assertNotInLiveTrain(db, workspaceId, "send-back")).resolves.toBeUndefined();
  });

  it("force bypasses the refusal", async () => {
    const { db, projectId, workspaceId } = await seed();
    registerLiveMergeTrain({ trainId: "train-1", label: "train/2026-10-12-06", projectId });
    await expect(assertNotInLiveTrain(db, workspaceId, "launch", true)).resolves.toBeUndefined();
  });
});
