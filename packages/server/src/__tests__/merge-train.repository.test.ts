import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mergeTrains, projects } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import {
  appendMergeTrainAttempt,
  createMergeTrain,
  findActiveMergeTrainForMembers,
  getMergeTrain,
  updateMergeTrainState,
} from "../repositories/merge-train.repository.js";

/**
 * #1158 — 59 stranded `merge_trains` rows (51 `assembling`) all naming the SAME 5 member
 * workspace ids, none ever resolved: `beginMergeTrain` inserted a fresh row on every attempt
 * for a batch, including a batch already stuck behind the repo lock. `findActiveMergeTrainForMembers`
 * is what a new attempt must consult first so it joins the existing row instead of minting one.
 */
async function seedProject(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(projects).values({
    id, name: "p", repoPath: "/tmp/p", repoName: "p", defaultBranch: "main",
    createdAt: now, updatedAt: now,
  });
  return id;
}

describe("findActiveMergeTrainForMembers (#1158)", () => {
  it("finds an assembling row with the exact same member set", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const members = ["ws-a", "ws-b", "ws-c"];
    const trainId = randomUUID();
    await createMergeTrain({ id: trainId, projectId, label: "q1", memberWorkspaceIds: members }, db);

    const found = await findActiveMergeTrainForMembers(projectId, members, db);
    expect(found?.id).toBe(trainId);
  });

  it("matches regardless of member ORDER (a re-run classifier may reorder the same set)", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const trainId = randomUUID();
    await createMergeTrain({ id: trainId, projectId, label: "q1", memberWorkspaceIds: ["ws-a", "ws-b", "ws-c"] }, db);

    const found = await findActiveMergeTrainForMembers(projectId, ["ws-c", "ws-a", "ws-b"], db);
    expect(found?.id).toBe(trainId);
  });

  it("matches a row in state 'gating' as well as 'assembling'", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const trainId = randomUUID();
    await createMergeTrain({ id: trainId, projectId, label: "q1", memberWorkspaceIds: ["ws-a", "ws-b"] }, db);
    await updateMergeTrainState(trainId, { state: "gating" }, db);

    const found = await findActiveMergeTrainForMembers(projectId, ["ws-a", "ws-b"], db);
    expect(found?.id).toBe(trainId);
  });

  it("does NOT match a landed/abandoned/red row — those are terminal, not reusable", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const trainId = randomUUID();
    await createMergeTrain({ id: trainId, projectId, label: "q1", memberWorkspaceIds: ["ws-a", "ws-b"] }, db);
    await updateMergeTrainState(trainId, { state: "landed", finishedAt: new Date().toISOString() }, db);

    const found = await findActiveMergeTrainForMembers(projectId, ["ws-a", "ws-b"], db);
    expect(found).toBeUndefined();
  });

  it("does NOT match a different (even overlapping) member set", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    await createMergeTrain({ id: randomUUID(), projectId, label: "q1", memberWorkspaceIds: ["ws-a", "ws-b"] }, db);

    const found = await findActiveMergeTrainForMembers(projectId, ["ws-a", "ws-b", "ws-c"], db);
    expect(found).toBeUndefined();
  });

  it("does NOT match a train belonging to a different project", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const otherProjectId = await seedProject(db);
    await createMergeTrain({ id: randomUUID(), projectId: otherProjectId, label: "q1", memberWorkspaceIds: ["ws-a", "ws-b"] }, db);

    const found = await findActiveMergeTrainForMembers(projectId, ["ws-a", "ws-b"], db);
    expect(found).toBeUndefined();
  });
});

/**
 * #1189 — bisect nodes are appended to a LIVE row's `gateEvidence.attempts` as they finish,
 * touching only that column: the state belongs to the gate and to an operator's cancel.
 */
describe("appendMergeTrainAttempt (#1189)", () => {
  const node = (label: string) => ({ label, members: ["ws-a"], included: ["ws-a"], dropped: [], gateStartedAt: null, gateFinishedAt: null, gateRuns: 1, verdict: "red" });

  it("appends in order and leaves the state alone", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const trainId = randomUUID();
    await createMergeTrain({ id: trainId, projectId, label: "q1", memberWorkspaceIds: ["ws-a"] }, db);
    await updateMergeTrainState(trainId, { state: "gating" }, db);

    await appendMergeTrainAttempt(trainId, node("q1"), db);
    await appendMergeTrainAttempt(trainId, node("q1a"), db);

    const row = await getMergeTrain(trainId, db);
    expect(row?.state).toBe("gating");
    const evidence = JSON.parse(row!.gateEvidence!) as { attempts: Array<{ label: string }> };
    expect(evidence.attempts.map((a) => a.label)).toEqual(["q1", "q1a"]);
  });

  it("does not resurrect an abandoned row, and keeps other evidence keys", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const trainId = randomUUID();
    await createMergeTrain({ id: trainId, projectId, label: "q1", memberWorkspaceIds: ["ws-a"] }, db);
    await updateMergeTrainState(trainId, { state: "abandoned", reconciledReason: "operator cancel", gateEvidence: { note: "kept" } }, db);

    await appendMergeTrainAttempt(trainId, node("q1"), db);

    const row = await getMergeTrain(trainId, db);
    expect(row?.state).toBe("abandoned");
    expect(row?.reconciledReason).toBe("operator cancel");
    expect(JSON.parse(row!.gateEvidence!)).toMatchObject({ note: "kept", attempts: [expect.objectContaining({ label: "q1" })] });
  });

  it("is a no-op for a row that does not exist, and replaces unparseable prior evidence", async () => {
    const { db } = createTestDb();
    await expect(appendMergeTrainAttempt(randomUUID(), node("q1"), db)).resolves.toBeUndefined();

    const projectId = await seedProject(db);
    const trainId = randomUUID();
    await createMergeTrain({ id: trainId, projectId, label: "q1", memberWorkspaceIds: ["ws-a"] }, db);
    await db.update(mergeTrains).set({ gateEvidence: "{not json" }).where(eq(mergeTrains.id, trainId));
    await appendMergeTrainAttempt(trainId, node("q1"), db);
    const row = await getMergeTrain(trainId, db);
    expect(JSON.parse(row!.gateEvidence!)).toEqual({ attempts: [node("q1")] });
  });
});
