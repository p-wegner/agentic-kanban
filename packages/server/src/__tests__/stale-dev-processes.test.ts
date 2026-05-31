import { describe, expect, it, vi } from "vitest";
import {
  classifyStaleDevProcessTrees,
  cleanStaleDevProcessSnapshot,
  resolveWorktreeDevPorts,
  type ActiveWorkspaceResource,
  type PortListener,
  type ProcessRecord,
} from "../services/stale-dev-processes.js";

const now = new Date("2026-05-31T12:00:00.000Z");

function proc(pid: number, ppid: number, commandLine: string, name = "node.exe"): ProcessRecord {
  return { pid, ppid, name, commandLine };
}

function listener(pid: number, port: number): PortListener {
  return { pid, port, address: `127.0.0.1:${port}`, protocol: "tcp" };
}

function classify(
  processes: ProcessRecord[],
  listeners: PortListener[],
  activeWorkspaces: ActiveWorkspaceResource[] = [],
  protectedPorts = new Set<number>([3001, 5173]),
  cleanupScopePaths = ["C:/repo", "C:/andrena/.worktrees"],
) {
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

describe("resolveWorktreeDevPorts", () => {
  it("uses the issue number when the workspace has one", () => {
    expect(resolveWorktreeDevPorts("C:/andrena/.worktrees/feature_ak-178-test", 178)).toEqual([3179, 5351]);
  });

  it("parses the issue number from worktree folder names as a fallback", () => {
    expect(resolveWorktreeDevPorts("C:/andrena/.worktrees/feature_ak-147-active", null)).toEqual([3148, 5320]);
  });
});

describe("classifyStaleDevProcessTrees", () => {
  it("cleans a pnpm dev tree with no listener ports and no active workspace association", () => {
    const snapshot = classify([
      proc(100, 1, "pnpm dev", "pnpm.cmd"),
      proc(101, 100, "node C:/repo/scripts/dev.mjs"),
      proc(102, 101, "node C:/repo/packages/server/node_modules/tsx/dist/cli.mjs watch src/index.ts"),
      proc(103, 101, "node C:/repo/packages/client/node_modules/vite/bin/vite.js"),
    ], []);

    expect(snapshot.cleaned).toHaveLength(1);
    expect(snapshot.cleaned[0]).toMatchObject({
      rootPid: 100,
      pids: [100, 101, 102, 103],
      action: "cleaned",
      reason: "stale-dev-tree-no-listeners",
    });
    expect(snapshot.processes.find((item) => item.pid === 101)?.parentAlive).toBe(true);
    expect(snapshot.kept).toHaveLength(0);
  });

  it("keeps a tree when any descendant owns a protected board or client listener", () => {
    const snapshot = classify([
      proc(100, 1, "pnpm dev", "pnpm.cmd"),
      proc(101, 100, "node C:/repo/scripts/dev.mjs"),
      proc(102, 101, "node C:/repo/packages/server/node_modules/tsx/dist/cli.mjs watch src/index.ts"),
    ], [listener(102, 3001)]);

    expect(snapshot.cleaned).toHaveLength(0);
    expect(snapshot.kept).toHaveLength(1);
    expect(snapshot.kept[0]).toMatchObject({
      rootPid: 100,
      listenerPorts: [3001],
      reason: "protected-port:3001",
    });
  });

  it("keeps a tree associated with an active worktree even when it has no listeners yet", () => {
    const activeWorkspaces: ActiveWorkspaceResource[] = [{
      workspaceId: "ws-active",
      issueId: "issue-active",
      issueNumber: 147,
      workingDir: "C:/andrena/.worktrees/feature_ak-147-active",
      sessionPid: null,
      ports: [3148, 5320],
    }];
    const snapshot = classify([
      proc(200, 1, "pnpm dev", "pnpm.cmd"),
      proc(201, 200, "node C:/andrena/.worktrees/feature_ak-147-active/scripts/dev.mjs"),
      proc(202, 201, "node C:/andrena/.worktrees/feature_ak-147-active/packages/client/node_modules/vite/bin/vite.js"),
    ], [], activeWorkspaces, new Set([3001, 5173, 3148, 5320]));

    expect(snapshot.cleaned).toHaveLength(0);
    expect(snapshot.kept[0]).toMatchObject({
      rootPid: 200,
      associatedWorkspaceIds: ["ws-active"],
      reason: "active-workspace",
    });
  });

  it("keeps a tree with a non-protected listener instead of treating it as orphaned", () => {
    const snapshot = classify([
      proc(300, 1, "pnpm dev", "pnpm.cmd"),
      proc(301, 300, "node C:/repo/scripts/dev.mjs"),
      proc(302, 301, "node C:/repo/packages/client/node_modules/vite/bin/vite.js"),
    ], [listener(302, 5555)]);

    expect(snapshot.cleaned).toHaveLength(0);
    expect(snapshot.kept[0]).toMatchObject({
      rootPid: 300,
      listenerPorts: [5555],
      reason: "listener-port:5555",
    });
  });

  it("keeps an unrelated dev tree outside the board cleanup scope", () => {
    const snapshot = classify([
      proc(350, 1, "pnpm dev", "pnpm.cmd"),
      proc(351, 350, "node C:/unrelated-app/scripts/dev.mjs"),
      proc(352, 351, "node C:/unrelated-app/packages/client/node_modules/vite/bin/vite.js"),
    ], [], [], new Set([3001, 5173]), ["C:/repo"]);

    expect(snapshot.cleaned).toHaveLength(0);
    expect(snapshot.kept[0]).toMatchObject({
      rootPid: 350,
      reason: "outside-cleanup-scope",
    });
  });

  it("cleans by exact root PID only, leaving descendant traversal to taskkill tree semantics", async () => {
    const snapshot = classify([
      proc(400, 1, "pnpm dev", "pnpm.cmd"),
      proc(401, 400, "node C:/repo/scripts/dev.mjs"),
      proc(402, 401, "node C:/repo/packages/server/node_modules/tsx/dist/cli.mjs watch src/index.ts"),
    ], []);
    const killTree = vi.fn(async () => {});

    await cleanStaleDevProcessSnapshot(snapshot, killTree);

    expect(killTree).toHaveBeenCalledTimes(1);
    expect(killTree).toHaveBeenCalledWith(400);
    expect(killTree).not.toHaveBeenCalledWith(401);
    expect(killTree).not.toHaveBeenCalledWith(402);
  });
});
