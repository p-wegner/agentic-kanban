/**
 * #990 — `GET /api/workspaces/:id/merge-status` could not report a merge that SUCCEEDED
 * across the restart the merge itself caused.
 *
 * A successful merge moves the main checkout's base branch, `tsx watch` restarts the server,
 * and the in-memory merge job map goes with it. `describeAbsentMergeJob` is the projection
 * that exists to answer for a lost job, and it already read two durable facts — the persisted
 * pre-merge gate verdict (#893) and the in-flight merge marker (#945). Neither covers success:
 * on a clean merge the marker is resolved rather than dangling, and a gate verdict only says
 * the gate passed, not that the merge landed. So the endpoint answered
 * "no merge job recorded for this workspace in the current server process" — the same sentence
 * it gives for a workspace nobody ever tried to merge.
 *
 * Measured 2026-09-01: hit twice in one merge-queue run (after #969's and #973's merges), each
 * time forcing the poller to fall back to the git tip to learn an outcome already stamped in
 * `workspaces.merged_at`.
 *
 * The subject here is the PROJECTION, not the merge. `describeAbsentMergeJob` is deliberately
 * extracted from its route handler so it is assertable without standing up a router, which is
 * what these tests do.
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";

vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const schemaMod = await import("@agentic-kanban/shared/schema");
  const { db } = createTestDb();
  return {
    db,
    writeDb: db,
    rawClient: undefined,
    rawWriteClient: undefined,
    schema: schemaMod,
    withDbRetry: <T>(fn: () => Promise<T>) => fn(),
    withTransaction: <T>(database: { transaction: (fn: unknown) => Promise<T> }, fn: unknown) =>
      database.transaction(fn),
  };
});

import { db } from "../db/index.js";
import { describeAbsentMergeJob } from "../routes/workspace-actions.js";

async function seedWorkspace(merged: { mergedAt: string; mergedHeadSha: string | null } | null) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: `p-${projectId.slice(0, 8)}`, repoPath: `C:/tmp/${projectId}`, repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "Done", sortOrder: 1, isDefault: false, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 990, title: "merge-status after the restart the merge caused",
    priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-990-test", workingDir: null, baseBranch: "master",
    isDirect: false, status: merged ? "closed" : "idle", readyForMerge: !merged, provider: "claude",
    mergedAt: merged?.mergedAt ?? null, mergedHeadSha: merged?.mergedHeadSha ?? null,
    createdAt: now, updatedAt: now,
  });
  return workspaceId;
}

describe("#990: describeAbsentMergeJob reports a merge that already landed", () => {
  it("answers completed — with the stamp and the merged sha — when merged_at is set", async () => {
    const mergedAt = new Date(Date.now() - 90_000).toISOString();
    const workspaceId = await seedWorkspace({ mergedAt, mergedHeadSha: "c94976a050" });

    const body = await describeAbsentMergeJob(workspaceId);

    // The whole bug: this used to be indistinguishable from "nobody ever tried".
    expect(body.outcome).toBe("completed");
    expect(body.mergedAt).toBe(mergedAt);
    // The sha is in the body so the caller does not have to consult git to believe it —
    // which is precisely the fallback the defect forced on every poller that hit it.
    expect(body.mergedHeadSha).toBe("c94976a050");
    expect(body.message).toContain("MERGED");
    expect(body.message).toContain("c94976a050");
    expect(body.message).toContain("No retry is needed.");
    // A `job: null` that now carries an outcome must still be a `job: null` — the field is the
    // endpoint's contract with every existing caller and this change is additive.
    expect(body.job).toBeNull();
  });

  it("does not claim a merge for a workspace that was never merged", async () => {
    const workspaceId = await seedWorkspace(null);

    const body = await describeAbsentMergeJob(workspaceId);

    expect(body.outcome).toBeUndefined();
    expect(body.mergedAt).toBeUndefined();
    expect(body.job).toBeNull();
    // The pre-#990 sentence is still the right answer for this case, and must not have been
    // replaced by the new one: a poller distinguishes the two by exactly this text.
    expect(body.message).toContain("no merge job recorded for this workspace");
  });

  it("reports completed for an unknown workspace id as it did before — absence is not success", async () => {
    const body = await describeAbsentMergeJob(randomUUID());

    // A row that does not exist has no `merged_at`, so the new branch must not fire. Asserted
    // because the read is wrapped in `.catch(() => undefined)` and a truthiness slip there
    // would turn "I could not look" into "it merged" — the one direction this must never fail in.
    expect(body.outcome).toBeUndefined();
    expect(body.job).toBeNull();
  });
});
