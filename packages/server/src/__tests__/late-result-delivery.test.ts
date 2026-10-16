import { describe, it, expect, vi, beforeEach } from "vitest";

const { findLive, running, sync, clear, record } = vi.hoisted(() => ({
  findLive: vi.fn(),
  running: vi.fn(),
  sync: vi.fn(),
  clear: vi.fn(),
  record: vi.fn(),
}));

vi.mock("../repositories/workspace-reads.repository.js", () => ({ findLiveWorkspacesOnBranch: findLive }));
vi.mock("../repositories/workspace-lifecycle-reconcile.repository.js", () => ({ getRunningSessionIdsForWorkspace: running }));
vi.mock("../repositories/worker.repository.js", () => ({ getWorkerById: async () => ({ name: "desktop" }) }));
vi.mock("../services/worker-remote-sync.service.js", () => ({ landWithRebaseAdoption: async (...a: unknown[]) => ({ outcome: await sync(...a) }), clearIncomingRef: clear }));
vi.mock("../services/worker-events.service.js", () => ({ recordWorkerEvent: record }));

import { deliverLateResult } from "../services/late-result-delivery.service.js";

const params = { projectId: "p", repoPath: "/r", branch: "feature/ak-1-x", workerId: "w" };
const db = {} as never;

describe("deliverLateResult (#1414)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findLive.mockResolvedValue([{ id: "ws1", workingDir: "/wt" }]);
    running.mockResolvedValue([]);
    sync.mockResolvedValue({ ok: true, status: "updated", via: "worktree" });
    clear.mockResolvedValue(undefined);
  });

  it("fast-forwards the branch and records the late-delivery note", async () => {
    const out = await deliverLateResult(params, db);
    expect(out).toMatchObject({ delivered: true, workspaceId: "ws1", note: "late result delivered by desktop" });
    expect(sync).toHaveBeenCalledWith("/r", "feature/ak-1-x", { worktreePath: "/wt" });
    expect(clear).toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ type: "ref_landed" }));
  });

  it("leaves a branch alone while a session is running", async () => {
    running.mockResolvedValue(["s1"]);
    const out = await deliverLateResult(params, db);
    expect(out.delivered).toBe(false);
    expect(sync).not.toHaveBeenCalled();
  });

  it("does nothing without an open workspace", async () => {
    findLive.mockResolvedValue([]);
    expect((await deliverLateResult(params, db)).delivered).toBe(false);
    expect(sync).not.toHaveBeenCalled();
  });

  it("holds a diverged result: keeps the ref and flags it", async () => {
    sync.mockResolvedValue({ ok: false, status: "diverged", error: "not a fast-forward" });
    const out = await deliverLateResult(params, db);
    expect(out).toMatchObject({ delivered: false, held: true });
    expect(clear).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ type: "ref_held" }));
  });
});
