/**
 * #1167 — an operator door onto `clearMergeBackoff`.
 *
 * Three workspaces sat permanently skipped every monitor cycle, logging "merge retries
 * exhausted ... waiting no longer resumes them; new work on the branch does". The clear
 * function already existed (`merge-backoff.service.ts`), but nothing exposed it over HTTP —
 * grep for "backoff" across `packages/server/src/routes` returned no matches. So the only
 * sanctioned way to resume was to push new work to the branch, which is wrong when the
 * failures were caused by an ENVIRONMENTAL fault rather than the branch itself.
 *
 * These tests pin the new routes against a REAL migrated test db (not a mocked service),
 * since the whole point is exercising the persisted backoff state.
 */
import { Hono } from "hono";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { workspaceMergeBackoff } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { seedProject, seedIssue, seedWorkspace } from "./helpers/workflow-test-helpers.js";
import { createWorkspaceActionsRoute } from "../routes/workspace-actions.js";

let db: TestDb;
let dispose: () => void;
let workspaceId: string;

beforeEach(async () => {
  const created = createTestDb();
  db = created.db;
  dispose = created.dispose;
  const { projectId, statusId } = await seedProject(db, `merge-backoff-route-${Date.now()}`);
  const issueId = await seedIssue(db, projectId, statusId, 1167, "backoff route fixture");
  workspaceId = await seedWorkspace(db, issueId, "feature/ak-1167-backoff", null, "C:/repo/.worktrees/ak-1167");
});

afterEach(() => {
  dispose?.();
});

function buildApp() {
  const app = new Hono();
  app.route("/api/workspaces", createWorkspaceActionsRoute(() => ({}) as never, db as never));
  return app;
}

async function seedBackoffRow(overrides: Partial<{
  failures: number;
  signature: string;
  nextRetryAt: string;
  branchSha: string | null;
}> = {}) {
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  await db.insert(workspaceMergeBackoff).values({
    workspaceId,
    failures: overrides.failures ?? 6,
    signature: overrides.signature ?? "generic|abc123",
    error: "pre-merge gate failed repeatedly",
    branchSha: overrides.branchSha ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    verifyHash: null,
    nextRetryAt: overrides.nextRetryAt ?? future,
    since: new Date(Date.now() - 60 * 60_000).toISOString(),
  });
}

describe("GET /api/workspaces/:id/merge-backoff", () => {
  it("reports no block for a workspace with no backoff row", async () => {
    const app = buildApp();
    const res = await app.request(`/api/workspaces/${workspaceId}/merge-backoff`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ blocked: false, failures: 0, failureClass: null });
  });

  it("reports the failure class and retry time for a blocked workspace", async () => {
    await seedBackoffRow({ failures: 6, signature: "generic|abc123" });
    const app = buildApp();
    const res = await app.request(`/api/workspaces/${workspaceId}/merge-backoff`);
    expect(res.status).toBe(200);
    const body = await res.json() as { blocked: boolean; failures: number; failureClass: string | null; nextRetryAt: string | null };
    expect(body.blocked).toBe(true);
    expect(body.failures).toBe(6);
    expect(body.failureClass).toBe("generic");
    expect(body.nextRetryAt).toBeTruthy();
  });

  it("404s for an unknown workspace", async () => {
    const app = buildApp();
    const res = await app.request("/api/workspaces/does-not-exist/merge-backoff");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/workspaces/:id/merge-backoff/clear", () => {
  it("clears a retry-ceiling-exhausted workspace so the monitor stops skipping it", async () => {
    await seedBackoffRow({ failures: 6, signature: "generic|abc123" });
    const app = buildApp();

    const res = await app.request(`/api/workspaces/${workspaceId}/merge-backoff/clear`, { method: "POST" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ cleared: true, previousFailures: 6 });

    // The row is really gone, not just reported gone.
    const rows = await db.select().from(workspaceMergeBackoff);
    expect(rows).toEqual([]);

    const statusRes = await app.request(`/api/workspaces/${workspaceId}/merge-backoff`);
    await expect(statusRes.json()).resolves.toMatchObject({ blocked: false, failures: 0 });
  });

  it("is a no-op (but still 200) for a workspace that was never blocked", async () => {
    const app = buildApp();
    const res = await app.request(`/api/workspaces/${workspaceId}/merge-backoff/clear`, { method: "POST" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ cleared: false, previousFailures: 0 });
  });

  it("404s for an unknown workspace", async () => {
    const app = buildApp();
    const res = await app.request("/api/workspaces/does-not-exist/merge-backoff/clear", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
