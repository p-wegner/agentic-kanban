/**
 * #995 — `GET /api/workspaces/:id/merge-status` could not report a merge that was INTERRUPTED
 * before it reached a verdict.
 *
 * The interruption IS recorded, but in a place the only client guaranteed to be watching does
 * not read. `merge-run-reconciler` writes a `merge-attempt` note on the issue and then calls
 * `clearMergeRun`, deleting the in-flight marker (#945) that `describeAbsentMergeJob` reads. So
 * the endpoint answered correctly for the few minutes before the sweep and then degraded to
 * "no merge job recorded for this workspace in the current server process" — verbatim what a
 * workspace nobody ever tried to merge gets. The longer a poller waited, the LESS the endpoint
 * knew, which is backwards for the one consumer whose entire behaviour is to wait.
 *
 * Measured live 2026-09-01 on merge job `merge-42eb8b43-1` (workspace 42eb8b43, issue #988),
 * killed by a dev-server hot-reload mid-gate.
 *
 * Same subject as `merge-status-absent-job-completed.test.ts`: the PROJECTION, asserted without
 * standing up a router. The ranking those two suites pin between them is
 * merged > interrupted > reusable gate verdict > nobody ever tried.
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
import { insertIssueComment, MERGE_INTERRUPTED_BY_RESTART } from "../repositories/issue-comments.repository.js";
import { describeInterruptedMerge } from "../startup/merge-run-reconciler.js";

interface Seeded {
  workspaceId: string;
  issueId: string;
}

async function seedWorkspace(): Promise<Seeded> {
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
    id: statusId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 995, title: "merge-status across the reconciler sweep",
    priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-995-test", workingDir: null, baseBranch: "master",
    isDirect: false, status: "idle", readyForMerge: false, provider: "claude",
    mergedAt: null, mergedHeadSha: null, createdAt: now, updatedAt: now,
  });
  return { workspaceId, issueId };
}

/**
 * Exactly what the reconciler writes at `merge-run-reconciler.ts` — the note built by the real
 * `describeInterruptedMerge` and the real `MERGE_INTERRUPTED_BY_RESTART` stamp, so this fixture
 * cannot drift into asserting a shape the writer no longer produces.
 */
async function recordInterruption(
  seeded: Seeded,
  opts: { jobId?: string; startedAt?: string; createdAt?: string } = {},
): Promise<void> {
  const jobId = opts.jobId ?? "merge-42eb8b43-1";
  await insertIssueComment({
    issueId: seeded.issueId,
    workspaceId: seeded.workspaceId,
    kind: "merge-attempt",
    author: "system",
    body: describeInterruptedMerge(
      `merge job ${jobId} was submitted 5 minutes ago and no job record for it exists any more`,
      "merge-endpoint",
      false,
    ),
    payload: {
      eventType: "warning",
      mergeReason: MERGE_INTERRUPTED_BY_RESTART,
      jobId,
      startedAt: opts.startedAt ?? new Date(Date.now() - 300_000).toISOString(),
      source: "merge-endpoint",
      pid: 1234,
    },
    createdAt: opts.createdAt ?? new Date(Date.now() - 240_000).toISOString(),
  });
}

describe("#995: describeAbsentMergeJob reports a merge that was interrupted", () => {
  it("answers interrupted from the RECORD, after the sweep has deleted the marker", async () => {
    const seeded = await seedWorkspace();
    await recordInterruption(seeded);

    // No merge_run row is seeded at all — that is the post-sweep world this ticket is about.
    const body = await describeAbsentMergeJob(seeded.workspaceId);

    expect(body.outcome).toBe("interrupted");
    expect(body.interruptedMergeRecord?.jobId).toBe("merge-42eb8b43-1");
    expect(body.interruptedMergeRecord?.source).toBe("merge-endpoint");
    // The live marker is genuinely gone; the answer must not pretend otherwise.
    expect(body.interruptedMerge).toBeNull();
    expect(body.job).toBeNull();
    // The sentences a poller distinguishes on. "NOT a gate failure" is the one that says nothing
    // was learned about the branch, which is what makes a retry cheap to justify.
    expect(body.message).toContain("INTERRUPTION");
    expect(body.message).toContain("NOT a gate failure");
    expect(body.message).toContain("nobody ever tried");
    // The exact sentence a never-tried workspace gets must NOT appear — that ambiguity is the bug.
    expect(body.message).not.toContain("no merge job recorded for this workspace");
  });

  it("still answers never-tried for a workspace with no merge history at all", async () => {
    const seeded = await seedWorkspace();

    const body = await describeAbsentMergeJob(seeded.workspaceId);

    expect(body.outcome).toBeUndefined();
    expect(body.interruptedMergeRecord).toBeUndefined();
    expect(body.message).toContain("no merge job recorded for this workspace");
  });

  it("does not resurrect an OLD interruption once a newer merge-attempt note supersedes it", async () => {
    const seeded = await seedWorkspace();
    await recordInterruption(seeded, { createdAt: new Date(Date.now() - 600_000).toISOString() });
    // The retry ran and its gate FAILED. That is a different, newer outcome, and reporting the
    // older interruption for it would be a stale answer dressed as a terminal one — the failure
    // mode of asking "is there an interruption anywhere in this workspace's history".
    await insertIssueComment({
      issueId: seeded.issueId,
      workspaceId: seeded.workspaceId,
      kind: "merge-attempt",
      author: "system",
      body: "Pre-merge gate FAILED: 3 test(s) failed on feature/ak-995-test.",
      payload: { eventType: "error", mergeReason: "pre_merge_gate_failed" },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const body = await describeAbsentMergeJob(seeded.workspaceId);

    expect(body.outcome).toBeUndefined();
    expect(body.interruptedMergeRecord).toBeUndefined();
  });

  it("lets a landed merge outrank a recorded interruption — merged is terminal", async () => {
    const seeded = await seedWorkspace();
    await recordInterruption(seeded);
    const mergedAt = new Date().toISOString();
    // The interrupted attempt was re-submitted and this time it landed. `merged_at` is checked
    // first for exactly this case: the older interruption is now history, not the answer.
    await db.update(workspaces)
      .set({ mergedAt, mergedHeadSha: "abc1234567", readyForMerge: false })
      .where(eq(workspaces.id, seeded.workspaceId));

    const body = await describeAbsentMergeJob(seeded.workspaceId);

    expect(body.outcome).toBe("completed");
    expect(body.mergedAt).toBe(mergedAt);
    expect(body.message).toContain("No retry is needed.");
  });

  it("never reports interrupted for an unknown workspace id", async () => {
    // The record read is wrapped in `.catch(() => null)`; a truthiness slip there would turn
    // "I could not look" into "a merge was interrupted", inventing an attempt that never happened.
    const body = await describeAbsentMergeJob(randomUUID());

    expect(body.outcome).toBeUndefined();
    expect(body.interruptedMergeRecord).toBeUndefined();
    expect(body.job).toBeNull();
  });
});
