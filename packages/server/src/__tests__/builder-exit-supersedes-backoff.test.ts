/**
 * #1556 — a builder exit with new commits supersedes the merge backoff recorded against the old
 * tip, and rearms readyForMerge (sprint has no review session to do it).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { workspaceMergeBackoff, workspaces } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { seedProject, seedIssue, seedWorkspace } from "./helpers/workflow-test-helpers.js";
import { getMergeBackoffState } from "../repositories/merge-backoff.repository.js";
import { supersedeStaleMergeBackoff, rearmReadyForMerge } from "../startup/exit/builder-exit-backoff.js";

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

let db: TestDb;
let dispose: () => void;
let ws: { id: string; projectId: string; workingDir: string };

beforeEach(async () => {
  const created = createTestDb();
  db = created.db;
  dispose = created.dispose;
  const { projectId, statusId } = await seedProject(db, `supersede-${Date.now()}`);
  const issueId = await seedIssue(db, projectId, statusId, 7, "fixture");
  const workingDir = "C:/repo/.worktrees/ak-7";
  const id = await seedWorkspace(db, issueId, "feature/ak-7-x", null, workingDir);
  ws = { id, projectId, workingDir };
  await db.insert(workspaceMergeBackoff).values({
    workspaceId: id, failures: 1, signature: "generic|x", error: "gate red", branchSha: OLD_SHA,
    nextRetryAt: new Date(Date.now() - 60_000).toISOString(), since: new Date().toISOString(),
  });
});
afterEach(() => dispose?.());

describe("supersedeStaleMergeBackoff (#1556)", () => {
  it("clears a backoff whose branchSha is no longer the tip, even past nextRetryAt", async () => {
    const cleared = await supersedeStaleMergeBackoff(ws, db, {
      getBranchHeadSha: async () => NEW_SHA,
      hasSubstantiveChangeSince: async () => true,
    });
    expect(cleared).toBe(true);
    const row = await getMergeBackoffState(ws.id, db);
    expect(row?.failures ?? 0).toBe(0);
  });

  it("keeps the backoff when the tip did not move", async () => {
    const cleared = await supersedeStaleMergeBackoff(ws, db, { getBranchHeadSha: async () => OLD_SHA });
    expect(cleared).toBe(false);
    expect((await getMergeBackoffState(ws.id, db))?.failures).toBe(1);
  });

  it("rearmReadyForMerge marks the workspace ready", async () => {
    await rearmReadyForMerge(ws.id, new Date().toISOString(), db);
    const [row] = await db.select({ r: workspaces.readyForMerge }).from(workspaces).where(eq(workspaces.id, ws.id));
    expect(row.r).toBe(true);
  });
});
