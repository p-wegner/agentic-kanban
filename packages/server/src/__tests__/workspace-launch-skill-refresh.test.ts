import { describe, expect, it, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { TICKET_CONTEXT_FILENAME } from "@agentic-kanban/shared/lib/ticket-context";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import { createWorkspaceSessionService } from "../services/workspace-session.service.js";

/**
 * Regression for #892: skills (and the CLAUDE.local.md ticket-context file) were
 * materialized into a worktree only at PROVISIONING time
 * (`workspace-provision.service.ts`). `POST /api/workspaces/:id/launch` (resume/relaunch,
 * `launchSession` in `workspace-session.service.ts`) never re-ran that step, so a resumed
 * workspace could launch into a worktree holding a stale skill or ticket-context file —
 * one that had since been edited in the DB, or on disk in the main checkout.
 *
 * Fix: `launchSession` now calls the SAME `materializeWorkspaceSkills` +
 * `writeWorktreeTicketContext` steps provisioning does (shared via
 * `workspace-provision.service.ts`), right before the agent starts. Non-fatal: a failure
 * there must never block the launch.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function seedWorkspace(
  db: TestDb,
  opts: { skillId?: string | null; worktreePath: string },
): Promise<{ workspaceId: string; projectId: string; issueId: string }> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const issueId = randomUUID();
  const statusId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId, name: "P", repoPath: "/tmp/does-not-matter-repo", repoName: "repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(schema.projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(schema.issues).values({
    id: issueId, issueNumber: 42, title: "Resume re-materializes skills", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(schema.workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-42-resume",
    workingDir: opts.worktreePath,
    baseBranch: "main", isDirect: false, status: "idle",
    provider: "claude", skillId: opts.skillId ?? null,
    createdAt: now, updatedAt: now,
  });

  return { workspaceId, projectId, issueId };
}

describe("launchSession re-materializes skills + ticket context on resume (#892)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — temp cleanup is best-effort */
      }
    }
  });

  it("overwrites a stale materialized skill with the current DB content and logs the change", async () => {
    const { db } = createTestDb();
    const worktreePath = makeTempDir("ak-launch-skill-refresh-");

    const skillId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.agentSkills).values({
      id: skillId,
      name: "board-navigator",
      description: "current",
      prompt: "# board-navigator\nUse the CURRENT board instructions.",
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
    });

    // Simulate a worktree provisioned BEFORE the skill was last edited.
    const skillDir = join(worktreePath, ".claude", "skills", "board-navigator");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: board-navigator\ndescription: stale\n---\n\nOld stale instructions.",
    );

    const { workspaceId } = await seedWorkspace(db, { skillId, worktreePath });

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const sessionManager = createMockSessionManager();
      const service = createWorkspaceSessionService({
        database: db,
        getSessionManager: () => sessionManager,
      });

      await service.launchSession(workspaceId);

      const materialized = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
      expect(materialized).toContain("CURRENT board instructions");
      expect(materialized).not.toContain("stale");

      const loggedUpdate = consoleLogSpy.mock.calls.some((call) =>
        String(call[0]).includes('skill "board-navigator" updated since this worktree was provisioned'),
      );
      expect(loggedUpdate).toBe(true);
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  it("refreshes the CLAUDE.local.md ticket-context file to the issue's current title", async () => {
    const { db } = createTestDb();
    const worktreePath = makeTempDir("ak-launch-context-refresh-");

    const { workspaceId, issueId } = await seedWorkspace(db, { worktreePath });

    // Simulate a stale ticket-context file left over from provisioning.
    writeFileSync(join(worktreePath, TICKET_CONTEXT_FILENAME), "# Stale ticket context\n\nOld title");

    // The ticket's title changed after the workspace was provisioned.
    await db.update(schema.issues)
      .set({ title: "Renamed after provisioning" })
      .where(eq(schema.issues.id, issueId));

    const sessionManager = createMockSessionManager();
    const service = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => sessionManager,
    });

    await service.launchSession(workspaceId);

    const refreshed = readFileSync(join(worktreePath, TICKET_CONTEXT_FILENAME), "utf-8");
    expect(refreshed).toContain("Renamed after provisioning");
  });

  it("does not block the launch when re-materialization fails", async () => {
    const { db } = createTestDb();
    const worktreePath = makeTempDir("ak-launch-refresh-failure-");
    const { workspaceId } = await seedWorkspace(db, { worktreePath });

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sessionManager = createMockSessionManager();
      const failingProvision = {
        materializeWorkspaceSkills: vi.fn(async () => {
          throw new Error("simulated materialization failure");
        }),
        writeWorktreeTicketContext: vi.fn(async () => null),
      } as unknown as Parameters<typeof createWorkspaceSessionService>[0]["provision"];
      const service = createWorkspaceSessionService({
        database: db,
        getSessionManager: () => sessionManager,
        provision: failingProvision,
      });

      await expect(service.launchSession(workspaceId)).resolves.toEqual(
        expect.objectContaining({ sessionId: expect.any(String) }),
      );

      const loggedWarning = consoleWarnSpy.mock.calls.some((call) =>
        String(call[0]).includes("re-materialization failed (non-fatal)"),
      );
      expect(loggedWarning).toBe(true);
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });
});
