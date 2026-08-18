// @covers workspaces.services.fixAndMergeSessionRecovery
//
// #648 item 3: `fix-and-merge-session-recovery.service.ts` had NO test at all, on the
// recovery path — the parachute nobody had ever pulled. These three functions are what
// un-wedge a workspace whose previous fix-and-merge attempt died leaving the row claiming
// work is in flight; if they misfire the workspace is stuck `fixing` forever and every
// later merge attempt bounces off it.
//
// Real test DB, fake session manager and git. Timestamps are seeded RELATIVE to now
// (`Date.now() - N`), never hardcoded ISO strings, because the zero-output recovery is a
// staleness check that a fixed date would age past.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, workspaces, issues, projectStatuses, sessions, sessionMessages } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import {
  forceStopSession,
  recoverFailedFixAndMergeSessionIfNeeded,
  recoverZeroOutputRunningFixAndMergeSession,
} from "../services/fix-and-merge-session-recovery.service.js";

type TestDb = ReturnType<typeof createTestDb>["db"];

function makeGit() {
  return {
    abortRebase: vi.fn(async () => undefined),
    ensureOnBranch: vi.fn(async () => undefined),
  };
}

async function seed(
  db: TestDb,
  opts: {
    workspaceStatus?: string;
    isDirect?: boolean;
    workingDir?: string | null;
    session?: {
      status: string;
      startedAgoMs: number;
      endedAgoMs?: number | null;
      triggerType?: string | null;
      stats?: string | null;
      messages?: number;
    };
  } = {},
) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo", defaultBranch: "master",
    createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0, createdAt: now });
  await db.insert(issues).values({
    id: issueId, issueNumber: 648, title: "Recovery", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-648-recovery",
    workingDir: opts.workingDir === undefined ? "/repo/.worktrees/ak-648" : opts.workingDir,
    baseBranch: "master", isDirect: opts.isDirect ?? false,
    status: opts.workspaceStatus ?? "fixing", provider: "claude", createdAt: now, updatedAt: now,
  });

  if (opts.session) {
    const s = opts.session;
    await db.insert(sessions).values({
      id: sessionId, workspaceId, executor: "claude-code", status: s.status,
      startedAt: new Date(Date.now() - s.startedAgoMs).toISOString(),
      endedAt: s.endedAgoMs == null ? null : new Date(Date.now() - s.endedAgoMs).toISOString(),
      triggerType: s.triggerType ?? null,
      stats: s.stats ?? null,
    });
    for (let i = 0; i < (s.messages ?? 0); i++) {
      await db.insert(sessionMessages).values({
        sessionId, type: "stdout", data: JSON.stringify({ type: "assistant" }), createdAt: now,
      });
    }
  }

  const workspace = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0];
  return { workspaceId, sessionId, workspace };
}

const readWorkspaceStatus = async (db: TestDb, id: string) =>
  (await db.select().from(workspaces).where(eq(workspaces.id, id)))[0].status;
const readSessionStatus = async (db: TestDb, id: string) =>
  (await db.select().from(sessions).where(eq(sessions.id, id)))[0].status;

describe("fix-and-merge session recovery (#648)", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  describe("forceStopSession", () => {
    it("stops via the session manager and marks the row stopped", async () => {
      const { sessionId } = await seed(db, { session: { status: "running", startedAgoMs: 5_000 } });
      const stopSession = vi.fn(async () => {});

      await forceStopSession(sessionId, "stale session", {
        database: db, gitService: makeGit(), getSessionManager: () => ({ stopSession }) as never,
      });

      expect(stopSession).toHaveBeenCalledWith(sessionId);
      expect(await readSessionStatus(db, sessionId)).toBe("stopped");
    });

    it("still marks the row stopped when the session manager throws", async () => {
      // The DB row is what every later pass reads; leaving it `running` because a
      // process could not be signalled is what wedges the workspace permanently.
      const { sessionId } = await seed(db, { session: { status: "running", startedAgoMs: 5_000 } });
      const stopSession = vi.fn(async () => { throw new Error("no such process"); });

      await forceStopSession(sessionId, "stale session", {
        database: db, gitService: makeGit(), getSessionManager: () => ({ stopSession }) as never,
      });

      expect(await readSessionStatus(db, sessionId)).toBe("stopped");
    });
  });

  describe("recoverFailedFixAndMergeSessionIfNeeded", () => {
    const deps = (database: TestDb, stopSession = vi.fn(async () => {})) => ({
      database, gitService: makeGit(), getSessionManager: () => ({ stopSession }) as never,
    });

    it("resets a `fixing` workspace whose latest session died in under a second", async () => {
      const { workspaceId, sessionId, workspace } = await seed(db, {
        workspaceStatus: "fixing",
        session: { status: "stopped", startedAgoMs: 10_000, endedAgoMs: 9_500 },
      });

      await recoverFailedFixAndMergeSessionIfNeeded(workspace, deps(db));

      expect(await readWorkspaceStatus(db, workspaceId)).toBe("idle");
      expect(await readSessionStatus(db, sessionId)).toBe("stopped");
    });

    it("resets when the session ran long but burned zero tokens", async () => {
      const { workspaceId, workspace } = await seed(db, {
        workspaceStatus: "fixing",
        session: {
          status: "stopped", startedAgoMs: 600_000, endedAgoMs: 60_000,
          stats: JSON.stringify({ inputTokens: 0, outputTokens: 0 }),
        },
      });

      await recoverFailedFixAndMergeSessionIfNeeded(workspace, deps(db));

      expect(await readWorkspaceStatus(db, workspaceId)).toBe("idle");
    });

    it("leaves a genuinely-worked session alone", async () => {
      const { workspaceId, workspace } = await seed(db, {
        workspaceStatus: "fixing",
        session: {
          status: "stopped", startedAgoMs: 600_000, endedAgoMs: 60_000,
          stats: JSON.stringify({ inputTokens: 12_000, outputTokens: 3_400 }),
        },
      });

      await recoverFailedFixAndMergeSessionIfNeeded(workspace, deps(db));

      expect(await readWorkspaceStatus(db, workspaceId)).toBe("fixing");
    });

    it("does nothing for a workspace that is not `fixing`", async () => {
      const { workspaceId, workspace } = await seed(db, {
        workspaceStatus: "idle",
        session: { status: "stopped", startedAgoMs: 10_000, endedAgoMs: 9_500 },
      });
      const stopSession = vi.fn(async () => {});

      await recoverFailedFixAndMergeSessionIfNeeded(workspace, deps(db, stopSession));

      expect(stopSession).not.toHaveBeenCalled();
      expect(await readWorkspaceStatus(db, workspaceId)).toBe("idle");
    });

    it("does nothing when the workspace has no sessions at all", async () => {
      const { workspaceId, workspace } = await seed(db, { workspaceStatus: "fixing" });

      await recoverFailedFixAndMergeSessionIfNeeded(workspace, deps(db));

      expect(await readWorkspaceStatus(db, workspaceId)).toBe("fixing");
    });
  });

  describe("recoverZeroOutputRunningFixAndMergeSession", () => {
    const deps = (database: TestDb, git = makeGit()) => ({
      database, gitService: git, getSessionManager: () => ({ stopSession: vi.fn(async () => {}) }) as never,
    });

    it("stops a >1min running fix-and-merge session with zero messages and un-wedges the worktree", async () => {
      const git = makeGit();
      const { workspaceId, sessionId, workspace } = await seed(db, {
        workspaceStatus: "fixing",
        session: { status: "running", startedAgoMs: 120_000, triggerType: "fix-and-merge" },
      });

      await recoverZeroOutputRunningFixAndMergeSession(workspace, deps(db, git));

      expect(await readSessionStatus(db, sessionId)).toBe("stopped");
      expect(await readWorkspaceStatus(db, workspaceId)).toBe("idle");
      // A stranded attempt can leave the worktree detached mid-rebase; not clearing that
      // re-strands the very retry this recovery exists to enable.
      expect(git.abortRebase).toHaveBeenCalledWith("/repo/.worktrees/ak-648");
      expect(git.ensureOnBranch).toHaveBeenCalledWith("/repo/.worktrees/ak-648", "feature/ak-648-recovery");
    });

    it("leaves a session that HAS produced messages alone", async () => {
      const { workspaceId, sessionId, workspace } = await seed(db, {
        workspaceStatus: "fixing",
        session: { status: "running", startedAgoMs: 120_000, triggerType: "fix-and-merge", messages: 3 },
      });

      await recoverZeroOutputRunningFixAndMergeSession(workspace, deps(db));

      expect(await readSessionStatus(db, sessionId)).toBe("running");
      expect(await readWorkspaceStatus(db, workspaceId)).toBe("fixing");
    });

    it("leaves a young session alone — under a minute is not yet evidence of anything", async () => {
      const { sessionId, workspace } = await seed(db, {
        workspaceStatus: "fixing",
        session: { status: "running", startedAgoMs: 10_000, triggerType: "fix-and-merge" },
      });

      await recoverZeroOutputRunningFixAndMergeSession(workspace, deps(db));

      expect(await readSessionStatus(db, sessionId)).toBe("running");
    });

    it("ignores a stale zero-output session that is not a fix-and-merge one", async () => {
      const { sessionId, workspace } = await seed(db, {
        workspaceStatus: "fixing",
        session: { status: "running", startedAgoMs: 120_000, triggerType: "user" },
      });

      await recoverZeroOutputRunningFixAndMergeSession(workspace, deps(db));

      expect(await readSessionStatus(db, sessionId)).toBe("running");
    });

    it("skips the git un-wedging for a direct workspace (there is no worktree to fix)", async () => {
      const git = makeGit();
      const { workspaceId, workspace } = await seed(db, {
        workspaceStatus: "fixing", isDirect: true, workingDir: "/repo",
        session: { status: "running", startedAgoMs: 120_000, triggerType: "fix-and-merge" },
      });

      await recoverZeroOutputRunningFixAndMergeSession(workspace, deps(db, git));

      expect(git.abortRebase).not.toHaveBeenCalled();
      expect(git.ensureOnBranch).not.toHaveBeenCalled();
      expect(await readWorkspaceStatus(db, workspaceId)).toBe("idle");
    });

    it("is inert without a session manager", async () => {
      const { sessionId, workspace } = await seed(db, {
        workspaceStatus: "fixing",
        session: { status: "running", startedAgoMs: 120_000, triggerType: "fix-and-merge" },
      });

      await recoverZeroOutputRunningFixAndMergeSession(workspace, { database: db, gitService: makeGit() });

      expect(await readSessionStatus(db, sessionId)).toBe("running");
    });
  });
});
