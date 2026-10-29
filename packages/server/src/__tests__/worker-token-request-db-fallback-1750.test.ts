// #1750 — a restarted daemon's result is restored with no git token, gets a 401, and asks the
// board for one. The board has already forgotten the session (hello omitted it), so the answer
// must come from the DB predicate the git transport itself uses, not from the in-memory map.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issues, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import { createRemoteRepoService } from "../services/agent-remote-repo-ops.js";
import { stopGitHttpServer } from "../services/git-http.service.js";
import { isAssignmentRefusal } from "../worker/worker-undelivered-retry.js";
import { WORKER_RESULT_LANDABLE_AFTER_END_MS } from "../repositories/worker.repository.js";

const PROJECT_ID = "9e000000-1111-2222-3333-444455556666";
const STATUS_ID = "9e001111-1111-2222-3333-444455556666";
const WORKER = "worker-alpha";

describe("git_token_request falls back to the DB (#1750)", () => {
  let db: Database;
  let dir: string;

  async function seed(opts: { branch: string; n: number; status: string; endedAgoMs?: number; workerId?: string }) {
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(issues).values({
      id: issueId, issueNumber: opts.n, title: "t", statusId: STATUS_ID, projectId: PROJECT_ID, createdAt: now, updatedAt: now,
    } as typeof issues.$inferInsert);
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch: opts.branch, baseBranch: "master", status: "active", createdAt: now, updatedAt: now,
    } as typeof workspaces.$inferInsert);
    await db.insert(sessions).values({
      id: sessionId, workspaceId, status: opts.status, startedAt: now,
      endedAt: opts.endedAgoMs === undefined ? null : new Date(Date.now() - opts.endedAgoMs).toISOString(),
      workerId: opts.workerId ?? WORKER,
    } as typeof sessions.$inferInsert);
    return sessionId;
  }

  async function ask(sessionId: string, workerId = WORKER) {
    const sent: any[] = [];
    const manager = { send: (_w: string, m: unknown) => (sent.push(m), true) } as any;
    const svc = createRemoteRepoService({ manager, database: db, sessions: new Map() });
    await svc.handleTokenRequest(workerId, sessionId, "req-1");
    return sent[0];
  }

  beforeEach(async () => {
    db = createTestDb().db as unknown as Database;
    dir = mkdtempSync(join(tmpdir(), "ak-1750-"));
    await db.insert(projects).values({
      id: PROJECT_ID, name: "p", repoPath: dir, defaultBranch: "master",
    } as typeof projects.$inferInsert);
    await db.insert(projectStatuses).values({
      id: STATUS_ID, projectId: PROJECT_ID, name: "In Progress", sortOrder: 0,
    } as typeof projectStatuses.$inferInsert);
  });

  afterEach(async () => {
    await stopGitHttpServer();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("issues a token for an untracked session whose dispatch is still running", async () => {
    const sid = await seed({ branch: "feature/ak-1-a", n: 1, status: "running" });
    const reply = await ask(sid);
    expect(reply.type).toBe("git_token");
    expect(reply.gitToken).toBeTruthy();
  });

  it("issues one for a session that ended inside the landable window", async () => {
    const sid = await seed({ branch: "feature/ak-2-a", n: 2, status: "failed", endedAgoMs: 60_000 });
    expect((await ask(sid)).gitToken).toBeTruthy();
  });

  it("refuses once the landable window has passed, for another worker, and for an unknown session", async () => {
    const old = await seed({
      branch: "feature/ak-3-a", n: 3, status: "failed", endedAgoMs: WORKER_RESULT_LANDABLE_AFTER_END_MS + 60_000,
    });
    expect((await ask(old)).gitToken).toBeUndefined();
    const live = await seed({ branch: "feature/ak-4-a", n: 4, status: "running" });
    expect((await ask(live, "worker-beta")).gitToken).toBeUndefined();
    expect((await ask(randomUUID())).gitToken).toBeUndefined();
  });

  it("the worker never classifies a 503 as an over assignment (#1748)", () => {
    expect(isAssignmentRefusal("fatal: The requested URL returned error: 503")).toBe(false);
    expect(isAssignmentRefusal("fatal: The requested URL returned error: 403")).toBe(true);
  });
});
