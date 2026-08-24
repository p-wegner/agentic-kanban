// #752 — held incoming refs must be OBSERVABLE and RECLAIMABLE.
//
// Decision 012 says a worker push that cannot be fast-forwarded is "reported and
// held". Holding worked; reporting did not: the sweep's `held` list was dropped by
// its caller and no HTTP/CLI surface could enumerate `refs/kanban/incoming/*`.
// These tests pin both the listing and the retention rule — notably that nothing
// holding unreachable commits is ever deleted automatically, at any age.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { projects as projectsTable, projectStatuses, issues, workspaces, sessions } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import { incomingRefFor } from "../services/worker-remote-sync.service.js";
import {
  listIncomingRefs,
  landIncomingRef,
  discardIncomingRef,
  reclaimLandedIncomingRefs,
  INCOMING_REF_STALE_AFTER_MS,
} from "../services/worker-incoming-refs.service.js";
import { createWorkersRoute } from "../routes/workers.js";

const PROJECT_ID = "77770000-1111-2222-3333-444455556666";
const STATUS_ID = "77771111-1111-2222-3333-444455556666";

describe("incoming-ref visibility and reclaim (#752)", () => {
  let db: Database;
  let repo: string;

  async function commit(message: string, file: string): Promise<string> {
    writeFileSync(join(repo, file), `${message}\n`);
    await gitExecOrThrow(["add", "."], { cwd: repo });
    await gitExecOrThrow(["commit", "-m", message], { cwd: repo });
    return (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: repo })).trim();
  }

  /** The persisted worker dispatch #246 requires before any ref may land. */
  async function seedWorkerAssignment(branch: string, issueNumber: number): Promise<void> {
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(issues).values({
      id: issueId, issueNumber, title: `assignment for ${branch}`,
      statusId: STATUS_ID, projectId: PROJECT_ID, createdAt: now, updatedAt: now,
    } as typeof issues.$inferInsert);
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch, baseBranch: "master", status: "active",
      createdAt: now, updatedAt: now,
    } as typeof workspaces.$inferInsert);
    await db.insert(sessions).values({
      id: randomUUID(), workspaceId, status: "stopped", startedAt: now, workerId: "worker-1",
    } as typeof sessions.$inferInsert);
  }

  beforeEach(async () => {
    db = createTestDb().db as unknown as Database;
    repo = mkdtempSync(join(tmpdir(), "ak-incoming-refs-"));
    await gitExecOrThrow(["init", "-b", "master", repo], {});
    await commit("base", "a.txt");
    await db.insert(projectsTable).values({
      id: PROJECT_ID, name: "incoming-fixture", repoPath: repo, defaultBranch: "master",
    } as typeof projectsTable.$inferInsert);
    await db.insert(projectStatuses).values({
      id: STATUS_ID, projectId: PROJECT_ID, name: "In Progress", sortOrder: 0,
    } as typeof projectStatuses.$inferInsert);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  /** A worker push: a commit parked under the incoming ref, off every branch. */
  async function pushIncoming(branch: string, file = "worker.txt"): Promise<string> {
    const base = (await gitExecOrThrow(["rev-parse", "refs/heads/master"], { cwd: repo })).trim();
    const sha = await commit(`worker work on ${branch}`, file);
    await gitExecOrThrow(["update-ref", incomingRefFor(branch), sha], { cwd: repo });
    await gitExecOrThrow(["reset", "--hard", base], { cwd: repo });
    return sha;
  }

  it("lists a held ref with its sha, subject, age and the reason it is held", async () => {
    const sha = await pushIncoming("feature/ak-10-unsolicited");

    const { refs, staleAfterMs } = await listIncomingRefs(db);
    expect(staleAfterMs).toBe(INCOMING_REF_STALE_AFTER_MS);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      projectId: PROJECT_ID,
      branch: "feature/ak-10-unsolicited",
      ref: incomingRefFor("feature/ak-10-unsolicited"),
      sha,
      validRefName: true,
      hasWorkerAssignment: false,
      alreadyLanded: false,
      // #246: the ref alone is not evidence of a dispatch, so it is held.
      heldReason: "no worker assignment for this branch",
      stale: false,
    });
    expect(refs[0].subject).toContain("worker work");
    expect(refs[0].committedAt).toBeTruthy();
  });

  it("reports a ref with a worker assignment as landable (heldReason null)", async () => {
    await seedWorkerAssignment("feature/ak-11-ok", 11);
    await pushIncoming("feature/ak-11-ok");
    const { refs } = await listIncomingRefs(db);
    expect(refs[0]).toMatchObject({ hasWorkerAssignment: true, heldReason: null });
  });

  it("flags a ref as stale past the retention threshold — and still never deletes it", async () => {
    await pushIncoming("feature/ak-12-old");
    const later = Date.now() + INCOMING_REF_STALE_AFTER_MS + 60_000;

    const fresh = await listIncomingRefs(db);
    expect(fresh.refs[0].stale).toBe(false);
    const aged = await listIncomingRefs(db, { nowMs: later });
    expect(aged.refs[0].stale).toBe(true);
    expect(aged.refs[0].ageMs).toBeGreaterThan(INCOMING_REF_STALE_AFTER_MS);

    // THE retention rule: age alone reclaims nothing. The work is on no branch.
    const reclaim = await reclaimLandedIncomingRefs(db, { nowMs: later });
    expect(reclaim.reclaimed).toEqual([]);
    expect(reclaim.held).toHaveLength(1);
    expect(reclaim.held[0]).toMatchObject({ branch: "feature/ak-12-old", stale: true });
    expect((await gitExec(["rev-parse", "--verify", incomingRefFor("feature/ak-12-old")], { cwd: repo })).code)
      .toBe(0);
  });

  it("reclaims ONLY refs whose commit is already reachable from a branch", async () => {
    // Redundant: the same commit is the tip of the real branch already.
    const landedSha = await pushIncoming("feature/ak-13-done", "done.txt");
    await gitExecOrThrow(["update-ref", "refs/heads/feature/ak-13-done", landedSha], { cwd: repo });
    // Unreachable: parked under the incoming namespace only.
    await pushIncoming("feature/ak-14-live", "live.txt");

    const reclaim = await reclaimLandedIncomingRefs(db);
    expect(reclaim.reclaimed.map((r) => r.branch)).toEqual(["feature/ak-13-done"]);
    expect(reclaim.held.map((h) => h.branch)).toEqual(["feature/ak-14-live"]);
    expect((await gitExec(["rev-parse", "--verify", incomingRefFor("feature/ak-13-done")], { cwd: repo })).code)
      .not.toBe(0);
    expect((await gitExec(["rev-parse", "--verify", incomingRefFor("feature/ak-14-live")], { cwd: repo })).code)
      .toBe(0);
  });

  it("reclaims a ref whose work reached the DEFAULT branch (the Done/merged case)", async () => {
    // A merged workspace: the branch is gone, but the commit is on master. Proving
    // reachability beats trusting a status column — same outcome, no assumption.
    const sha = await pushIncoming("feature/ak-15-merged", "merged.txt");
    await gitExecOrThrow(["update-ref", "refs/heads/master", sha], { cwd: repo });

    const reclaim = await reclaimLandedIncomingRefs(db);
    expect(reclaim.reclaimed).toHaveLength(1);
    expect(reclaim.reclaimed[0].reason).toContain("already landed on master");
  });

  it("lands a held ref on operator request — including into a worktree that holds the branch", async () => {
    const branch = "feature/ak-16-held";
    await seedWorkerAssignment(branch, 16);
    const base = (await gitExecOrThrow(["rev-parse", "refs/heads/master"], { cwd: repo })).trim();
    const worktree = join(repo, "..", `incoming-wt-${Date.now()}`);
    await gitExecOrThrow(["worktree", "add", "-b", branch, worktree, base], { cwd: repo });
    try {
      const sha = await pushIncoming(branch, "operator.txt");

      const landed = await landIncomingRef(PROJECT_ID, branch, db);
      expect(landed.ok).toBe(true);
      expect(landed.ok && landed.outcome.via).toBe("worktree");
      expect((await gitExecOrThrow(["rev-parse", `refs/heads/${branch}`], { cwd: repo })).trim()).toBe(sha);
      // Landing clears the staging ref, so the listing is empty afterwards.
      expect((await listIncomingRefs(db)).refs).toEqual([]);
    } finally {
      await gitExec(["worktree", "remove", "--force", worktree], { cwd: repo });
    }
  });

  it("refuses an operator land for a branch with no worker dispatch (#246 stays closed)", async () => {
    const branch = "feature/ak-17-injected";
    const sha = await pushIncoming(branch, "injected.txt");
    const result = await landIncomingRef(PROJECT_ID, branch, db);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("no worker assignment");
    // Nothing moved, nothing was dropped.
    expect((await gitExec(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: repo })).code).not.toBe(0);
    expect((await gitExecOrThrow(["rev-parse", incomingRefFor(branch)], { cwd: repo })).trim()).toBe(sha);
  });

  it("refuses to discard young unreachable work, and allows it explicitly", async () => {
    const branch = "feature/ak-18-young";
    await pushIncoming(branch, "young.txt");

    const refused = await discardIncomingRef(PROJECT_ID, branch, db);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("land it, or pass force");
    expect((await gitExec(["rev-parse", "--verify", incomingRefFor(branch)], { cwd: repo })).code).toBe(0);

    const forced = await discardIncomingRef(PROJECT_ID, branch, db, { force: true });
    expect(forced.ok).toBe(true);
    expect(forced.sha).toBeTruthy();
    expect((await gitExec(["rev-parse", "--verify", incomingRefFor(branch)], { cwd: repo })).code).not.toBe(0);
  });

  it("allows discarding a ref that is past the retention threshold", async () => {
    const branch = "feature/ak-19-stale";
    await pushIncoming(branch, "stale.txt");
    const later = Date.now() + INCOMING_REF_STALE_AFTER_MS + 60_000;
    const result = await discardIncomingRef(PROJECT_ID, branch, db, { nowMs: later });
    expect(result.ok).toBe(true);
    expect((await gitExec(["rev-parse", "--verify", incomingRefFor(branch)], { cwd: repo })).code).not.toBe(0);
  });

  it("serves the same view over HTTP, with land and discard actions", async () => {
    const branch = "feature/ak-20-http";
    await pushIncoming(branch, "http.txt");
    const app = new Hono();
    app.route("/api/workers", createWorkersRoute(db));

    const listed = await app.request("/api/workers/incoming");
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { refs: Array<{ branch: string; heldReason: string }>; staleAfterMs: number };
    expect(body.refs.map((r) => r.branch)).toEqual([branch]);
    expect(body.staleAfterMs).toBe(INCOMING_REF_STALE_AFTER_MS);

    // No dispatch on record => landing is refused, with the reason, not a 500.
    const land = await app.request("/api/workers/incoming/land", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: PROJECT_ID, branch }),
    });
    expect(land.status).toBe(409);
    expect(((await land.json()) as { error: string }).error).toContain("no worker assignment");

    // A young unreachable ref is not droppable by accident either.
    const discard = await app.request("/api/workers/incoming/discard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: PROJECT_ID, branch }),
    });
    expect(discard.status).toBe(409);

    const forced = await app.request("/api/workers/incoming/discard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: PROJECT_ID, branch, force: true }),
    });
    expect(forced.status).toBe(200);
    expect((await listIncomingRefs(db)).refs).toEqual([]);
  });
});
