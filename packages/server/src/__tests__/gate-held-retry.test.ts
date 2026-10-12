/** #1423 — a HELD review-exit gate is retried after a backoff, never treated as a red verdict. */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  gateHeldRetryDelayMs,
  isGateWithheldForHead,
  markReviewExitGateHeld,
  markReviewExitGateWithheld,
} from "../startup/exit/gate-withheld-marker.js";

async function seed() {
  const { db } = createTestDb();
  const now = new Date().toISOString();
  const projectId = randomUUID(), statusId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "T", repoPath: "/r", repoName: "r", defaultBranch: "master", createdAt: now, updatedAt: now });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now });
  await db.insert(issues).values({ id: issueId, issueNumber: 1, title: "t", priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now });
  await db.insert(workspaces).values({ id: workspaceId, issueId, branch: "b", workingDir: "/r/w", baseBranch: "master", isDirect: false, status: "idle", readyForMerge: false, mergedAt: null, provider: "claude", createdAt: now, updatedAt: now });
  return { db, issueId, workspaceId };
}
const git = { revParse: async () => "abc12345\n" };

describe("held gate retry (#1423)", () => {
  it("withholds until retryAt, then lets the reconciler re-arm", async () => {
    const { db, issueId, workspaceId } = await seed();
    const t0 = Date.now();
    const retryAt = await markReviewExitGateHeld({ workspaceId, issueId, workingDir: "/r/w", message: "only 0.7GB free", nowMs: t0 }, { database: db, gitService: git });
    expect(retryAt).toBe(new Date(t0 + gateHeldRetryDelayMs(0)).toISOString());
    expect(await isGateWithheldForHead(db, workspaceId, "abc12345", t0 + 60_000)).toBe(true);
    expect(await isGateWithheldForHead(db, workspaceId, "abc12345", t0 + gateHeldRetryDelayMs(0) + 1)).toBe(false);
    expect(await isGateWithheldForHead(db, workspaceId, "other", t0 + 60_000)).toBe(false);
  });

  it("backs off further on repeated holds", async () => {
    const { db, issueId, workspaceId } = await seed();
    const t0 = Date.now();
    await markReviewExitGateHeld({ workspaceId, issueId, workingDir: "/r/w", message: "m", nowMs: t0 }, { database: db, gitService: git });
    const second = await markReviewExitGateHeld({ workspaceId, issueId, workingDir: "/r/w", message: "m", nowMs: t0 + 1000 }, { database: db, gitService: git });
    expect(Date.parse(second!)).toBe(t0 + 1000 + gateHeldRetryDelayMs(1));
  });

  it("a red verdict still withholds indefinitely", async () => {
    const { db, issueId, workspaceId } = await seed();
    await markReviewExitGateWithheld({ workspaceId, issueId, workingDir: "/r/w", message: "red" }, { database: db, gitService: git });
    expect(await isGateWithheldForHead(db, workspaceId, "abc12345", Date.now() + 86_400_000)).toBe(true);
  });
});
