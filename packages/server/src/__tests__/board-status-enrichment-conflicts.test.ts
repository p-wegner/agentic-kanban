import { describe, expect, it, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projects, projectStatuses, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { insertWorkspaceRepo } from "../repositories/repo.repository.js";
import { detectMultiRepoConflicts } from "../services/board-status-enrichment.js";

// #76: the board conflict badge must reflect conflicts in EVERY repo of a multi-repo
// workspace (leading + siblings), not just the leading worktree. detectMultiRepoConflicts
// takes an injectable `detect` so the merge-tree probe is faked per repo path.

type WorkspaceRow = typeof workspaces.$inferSelect;

async function seed(db: ReturnType<typeof createTestDb>["db"], opts: { isDirect?: boolean } = {}) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "T", repoPath: "/repo", repoName: "repo", defaultBranch: "master", createdAt: now, updatedAt: now });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now });
  await db.insert(issues).values({ id: issueId, issueNumber: 1, title: "i", priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1-x", workingDir: "/repo/.worktrees/ws",
    baseBranch: "master", isDirect: opts.isDirect ?? false, status: "idle", provider: "claude",
    createdAt: now, updatedAt: now,
  });
  const [ws] = await db.select().from(workspaces);
  return { projectId, workspaceId, ws: ws as WorkspaceRow };
}

/** Fake merge-tree probe: conflicts only for the repo dirs named in `conflicting`. */
function fakeDetect(conflicting: Record<string, string[]>) {
  return async (repoDir: string) => {
    const files = conflicting[repoDir];
    return files ? { hasConflicts: true, conflictingFiles: files } : { hasConflicts: false, conflictingFiles: [] as string[] };
  };
}

describe("detectMultiRepoConflicts (#76)", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  beforeEach(() => { ({ db } = createTestDb()); });

  it("surfaces a SIBLING-only conflict even when the leading worktree is clean", async () => {
    const { projectId, workspaceId, ws } = await seed(db);
    await insertWorkspaceRepo({ workspaceId, projectId, path: "/auth", name: "auth-svc", worktreePath: "/auth/.wt/ws", branch: "feature/ak-1-x", baseBranch: "main" }, db);
    await insertWorkspaceRepo({ workspaceId, projectId, path: "/gw", name: "gateway", worktreePath: "/gw/.wt/ws", branch: "feature/ak-1-x", baseBranch: "main" }, db);

    // Leading clean; the auth-svc sibling worktree conflicts.
    const detect = fakeDetect({ "/auth/.wt/ws": ["src/server.js"] });
    const result = await detectMultiRepoConflicts(ws, ws.workingDir!, "master", db, detect);

    expect(result.hasConflicts).toBe(true); // was false before the fix (leading-only)
    expect(result.conflictingFiles).toContain("auth-svc::src/server.js"); // namespaced
  });

  it("reports clean when no repo (leading or sibling) conflicts", async () => {
    const { projectId, workspaceId, ws } = await seed(db);
    await insertWorkspaceRepo({ workspaceId, projectId, path: "/auth", name: "auth-svc", worktreePath: "/auth/.wt/ws", branch: "feature/ak-1-x", baseBranch: "main" }, db);
    const result = await detectMultiRepoConflicts(ws, ws.workingDir!, "master", db, fakeDetect({}));
    expect(result.hasConflicts).toBe(false);
    expect(result.conflictingFiles).toEqual([]);
  });

  it("combines a leading conflict with a sibling conflict (namespaced siblings only)", async () => {
    const { projectId, workspaceId, ws } = await seed(db);
    await insertWorkspaceRepo({ workspaceId, projectId, path: "/auth", name: "auth-svc", worktreePath: "/auth/.wt/ws", branch: "feature/ak-1-x", baseBranch: "main" }, db);
    const detect = fakeDetect({ "/repo/.worktrees/ws": ["pkg.json"], "/auth/.wt/ws": ["a.js"] });
    const result = await detectMultiRepoConflicts(ws, ws.workingDir!, "master", db, detect);
    expect(result.hasConflicts).toBe(true);
    expect(result.conflictingFiles).toContain("pkg.json"); // leading NOT namespaced
    expect(result.conflictingFiles).toContain("auth-svc::a.js");
  });

  it("does not scan siblings for a direct workspace", async () => {
    const { projectId, workspaceId, ws } = await seed(db, { isDirect: true });
    // A sibling row exists but must be ignored for a direct workspace.
    await insertWorkspaceRepo({ workspaceId, projectId, path: "/auth", name: "auth-svc", worktreePath: "/auth/.wt/ws", branch: "feature/ak-1-x", baseBranch: "main" }, db);
    const detect = fakeDetect({ "/auth/.wt/ws": ["src/server.js"] });
    const result = await detectMultiRepoConflicts(ws, ws.workingDir!, "master", db, detect);
    expect(result.hasConflicts).toBe(false);
  });
});
