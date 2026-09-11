// #1105 — the monitor's resource sweep must never treat the shared `.worktrees` PARENT
// directory as "in cleanup scope" just because some registered workspace happens to live
// under it. Scope must be exactly the working directories the board actually knows about
// (any status), so a hand-made worktree beside a registered one is left alone entirely.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  classifyStaleDevProcessTrees,
  getWorkspaceCleanupScopePaths,
  type ActiveWorkspaceResource,
  type PortListener,
  type ProcessRecord,
} from "../services/stale-dev-processes.js";

const now = new Date("2026-09-11T21:00:00.000Z");

function proc(pid: number, ppid: number, commandLine: string, name = "node.exe"): ProcessRecord {
  return { pid, ppid, name, commandLine };
}

function listener(pid: number, port: number): PortListener {
  return { pid, port, address: `127.0.0.1:${port}`, protocol: "tcp" };
}

async function seedWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  opts: { workingDir: string; status: string; issueNumber: number },
) {
  const nowIso = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Test Project", repoPath: "C:/projects/andrena/agentic-kanban", repoName: "agentic-kanban",
    defaultBranch: "master", createdAt: nowIso, updatedAt: nowIso,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: nowIso,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: opts.issueNumber, title: "seed", description: null,
    priority: "medium", sortOrder: 0, statusId, projectId, createdAt: nowIso, updatedAt: nowIso,
  });
  await db.insert(workspaces).values({
    id: randomUUID(), issueId, branch: `feature/ak-${opts.issueNumber}-x`, workingDir: opts.workingDir,
    baseBranch: "master", isDirect: false, status: opts.status, provider: "claude",
    createdAt: nowIso, updatedAt: nowIso,
  });
}

describe("getWorkspaceCleanupScopePaths (#1105)", () => {
  it("scopes to each workspace's own working dir, never the shared .worktrees parent", async () => {
    const { db } = createTestDb();
    await seedWorkspace(db, {
      workingDir: "C:/projects/andrena/.worktrees/agentic-kanban/ak-1103",
      status: "active",
      issueNumber: 1103,
    });

    const scope = await getWorkspaceCleanupScopePaths(db);

    expect(scope).toEqual(["c:/projects/andrena/.worktrees/agentic-kanban/ak-1103"]);
    expect(scope).not.toContain("c:/projects/andrena/.worktrees");
  });

  it("still scopes a CLOSED workspace's working dir, so a leaked tree under it stays reapable", async () => {
    const { db } = createTestDb();
    await seedWorkspace(db, {
      workingDir: "C:/projects/andrena/.worktrees/agentic-kanban/ak-1000-closed",
      status: "closed",
      issueNumber: 1000,
    });

    const scope = await getWorkspaceCleanupScopePaths(db);

    expect(scope).toEqual(["c:/projects/andrena/.worktrees/agentic-kanban/ak-1000-closed"]);
  });
});

describe("classifyStaleDevProcessTrees keeps a hand-made worktree that no workspace row references (#1105)", () => {
  const cleanupScopePaths = ["c:/projects/andrena/.worktrees/agentic-kanban/ak-1103"];
  const activeWorkspaces: ActiveWorkspaceResource[] = [];
  const protectedPorts = new Set<number>([3001, 5173]);

  function classify(processes: ProcessRecord[], listeners: PortListener[]) {
    return classifyStaleDevProcessTrees({
      processes,
      listeners,
      activeWorkspaces,
      cleanupScopePaths,
      protectedPorts,
      protectedPidSet: new Set<number>(),
      now,
    });
  }

  it("keeps a test-run tree under an unregistered worktree, with no listeners", () => {
    const snapshot = classify([
      proc(36112, 1, "pnpm test:mine -- --changed master", "pnpm.cmd"),
      proc(36113, 36112, "node C:/projects/andrena/.worktrees/agentic-kanban/ak-1102/node_modules/vitest/dist/cli.js run"),
    ], []);

    expect(snapshot.cleaned).toHaveLength(0);
    expect(snapshot.kept[0]).toMatchObject({ rootPid: 36112, reason: "outside-cleanup-scope" });
  });

  it("keeps a dev-server tree under an unregistered worktree, even while it holds a listener port", () => {
    const snapshot = classify([
      proc(9001, 1, "pnpm dev", "pnpm.cmd"),
      proc(9002, 9001, "node C:/projects/andrena/.worktrees/agentic-kanban/ak-1102/scripts/dev.mjs"),
      proc(9003, 9002, "node C:/projects/andrena/.worktrees/agentic-kanban/ak-1102/packages/client/node_modules/vite/bin/vite.js"),
    ], [listener(9003, 6275)]);

    expect(snapshot.cleaned).toHaveLength(0);
    expect(snapshot.kept[0]).toMatchObject({ rootPid: 9001, reason: "outside-cleanup-scope" });
  });

  it("still reaps an orphaned tree inside a REGISTERED workspace's own working dir", () => {
    const snapshot = classify([
      proc(9101, 1, "pnpm dev", "pnpm.cmd"),
      proc(9102, 9101, "node C:/projects/andrena/.worktrees/agentic-kanban/ak-1103/scripts/dev.mjs"),
    ], []);

    expect(snapshot.kept).toHaveLength(0);
    expect(snapshot.cleaned[0]).toMatchObject({ rootPid: 9101, reason: "stale-dev-tree-no-listeners" });
  });
});
