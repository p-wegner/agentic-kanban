import { describe, it, expect, vi, beforeEach } from "vitest";

// startup-tasks pulls in the db + a wide service graph at import time; stub the
// pieces this suite never exercises so the module can load in isolation.
vi.mock("../db/index.js", () => ({
  db: { select: vi.fn(), update: vi.fn(), delete: vi.fn(), insert: vi.fn() },
  rawClient: {},
  rawWriteClient: {},
}));
vi.mock("../services/git.service.js", () => ({
  abortMerge: vi.fn(async () => {}),
  abortRebase: vi.fn(async () => {}),
}));
vi.mock("../db/manual-migrate.js", () => ({ applyMigrations: vi.fn(async () => {}) }));
vi.mock("../db/seed.js", () => ({ ensureBuiltinTags: vi.fn(async () => {}), ensureBuiltinSkills: vi.fn(async () => {}) }));
vi.mock("../services/project-registration.js", () => ({ deduplicateProjects: vi.fn(async () => {}) }));
vi.mock("../services/workspace-repos.service.js", () => ({ cleanupSiblingWorktrees: vi.fn(async () => {}) }));
vi.mock("../services/process-exec.js", () => ({
  listOsProcesses: vi.fn(async () => []),
  taskkillTree: vi.fn(async () => {}),
  // The ONE kill seam (#828). The suite used to mock only `taskkillTree`, so on POSIX the
  // sweep took an unmocked `process.kill` path and asked the OS to SIGKILL a fabricated
  // pid — ESRCH, zero kills, a green suite on Windows and a red one everywhere else.
  killProcessTree: vi.fn(async () => {}),
  execCommand: vi.fn(async () => ({ stdout: "", stderr: "" })),
}));

import { reapParentlessChildServers } from "../startup/startup-tasks.js";
import { listOsProcesses, killProcessTree } from "../services/process-exec.js";

/** Build an OS process record; `ppid` defaults to a pid that is never in the list. */
function proc(pid: number, commandLine: string, ppid = 99999) {
  return { pid, ppid, name: "node.exe", commandLine };
}

describe("reapParentlessChildServers (#281)", () => {
  beforeEach(() => {
    vi.mocked(killProcessTree).mockClear();
    vi.mocked(listOsProcesses).mockReset();
  });

  it("kills a serve.mjs whose parent is gone", async () => {
    vi.mocked(listOsProcesses).mockResolvedValue([
      proc(1000, "node C:/plugins/foo/tools/plugin/serve.mjs --port 7001", 4242),
    ]);

    const killed = await reapParentlessChildServers();

    expect(killed).toBe(1);
    expect(vi.mocked(killProcessTree)).toHaveBeenCalledWith(1000);
  });

  it("leaves a serve.mjs alone when its parent is still alive", async () => {
    // The parent (2000) is present in the same snapshot, so this child belongs to a
    // live supervisor — possibly another worktree's dev server. Never touch it.
    vi.mocked(listOsProcesses).mockResolvedValue([
      proc(2000, "node scripts/dev.mjs", 1),
      proc(2001, "node tools/plugin/serve.mjs --port 7002", 2000),
    ]);

    const killed = await reapParentlessChildServers();

    expect(killed).toBe(0);
    expect(vi.mocked(killProcessTree)).not.toHaveBeenCalled();
  });

  it("never reaps a dev.mjs supervisor, even when parentless", async () => {
    // A detached dev server legitimately has no live parent. Killing it is the
    // documented never-do: it takes down another agent's whole worktree server.
    vi.mocked(listOsProcesses).mockResolvedValue([
      proc(3000, "node C:/projects/other/scripts/dev.mjs", 4242),
    ]);

    const killed = await reapParentlessChildServers();

    expect(killed).toBe(0);
    expect(vi.mocked(killProcessTree)).not.toHaveBeenCalled();
  });

  it("never reaps an agent or backend process", async () => {
    vi.mocked(listOsProcesses).mockResolvedValue([
      proc(4000, "node --import tsx src/index.ts", 4242),
      proc(4001, "claude.exe --resume abc", 4242),
    ]);

    expect(await reapParentlessChildServers()).toBe(0);
    expect(vi.mocked(killProcessTree)).not.toHaveBeenCalled();
  });

  it("treats ppid 0 as unknown rather than orphaned", async () => {
    // Some enumerator rows carry no parent id. That is missing information, not
    // proof of orphanhood — guessing here would kill live view servers.
    vi.mocked(listOsProcesses).mockResolvedValue([
      proc(5000, "node tools/plugin/serve.mjs", 0),
    ]);

    expect(await reapParentlessChildServers()).toBe(0);
    expect(vi.mocked(killProcessTree)).not.toHaveBeenCalled();
  });

  it("never reaps itself", async () => {
    vi.mocked(listOsProcesses).mockResolvedValue([
      proc(process.pid, "node serve.mjs pretending to be us", 4242),
    ]);

    expect(await reapParentlessChildServers()).toBe(0);
    expect(vi.mocked(killProcessTree)).not.toHaveBeenCalled();
  });

  it("reaps review-server.mjs and ui-map-serve.mjs too", async () => {
    vi.mocked(listOsProcesses).mockResolvedValue([
      proc(6000, "node review-server.mjs", 4242),
      proc(6001, "node ui-map-serve.mjs", 4242),
    ]);

    expect(await reapParentlessChildServers()).toBe(2);
  });

  it("returns 0 and does not throw when process enumeration fails", async () => {
    vi.mocked(listOsProcesses).mockRejectedValue(new Error("wmic unavailable"));

    await expect(reapParentlessChildServers()).resolves.toBe(0);
    expect(vi.mocked(killProcessTree)).not.toHaveBeenCalled();
  });
});
