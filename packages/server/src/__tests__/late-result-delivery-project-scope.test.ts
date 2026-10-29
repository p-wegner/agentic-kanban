import { describe, it, expect, vi } from "vitest";
import { projects, projectStatuses, issues, workspaces, sessions } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";

const { sync, record } = vi.hoisted(() => ({ sync: vi.fn(), record: vi.fn() }));
vi.mock("../services/worker-remote-sync.service.js", () => ({
  landWithRebaseAdoption: async (...a: unknown[]) => ({ outcome: await sync(...a) }),
  clearIncomingRef: async () => {},
}));
vi.mock("../services/worker-events.service.js", () => ({ recordWorkerEvent: record }));

import { deliverLateResult } from "../services/late-result-delivery.service.js";

describe("deliverLateResult project scoping (#1749)", () => {
  it("attributes the push to its own project's workspace, ignoring a running session elsewhere", async () => {
    const { db, dispose } = createTestDb();
    const branch = "fix/flaky-tests";
    for (const id of ["A", "B"]) {
      await db.insert(projects).values({ id: `proj-${id}`, name: id, repoPath: `/tmp/${id}` });
      await db.insert(projectStatuses).values({ id: `st-${id}`, projectId: `proj-${id}`, name: "In Progress", sortOrder: 1 });
      await db.insert(issues).values({ id: `is-${id}`, issueNumber: 12, title: "t", statusId: `st-${id}`, projectId: `proj-${id}` });
      await db.insert(workspaces).values({ id: `ws-${id}`, issueId: `is-${id}`, branch, status: "idle", workingDir: `/wt/${id}` });
    }
    // Project B's workspace is listed first-ish and has a running session; A's has none.
    await db.insert(sessions).values({ id: "s-B", workspaceId: "ws-B", status: "running" } as never);
    sync.mockResolvedValue({ ok: true, status: "updated", via: "worktree" });

    const out = await deliverLateResult({ projectId: "proj-A", repoPath: "/tmp/A", branch, workerId: "w" }, db);

    expect(out).toMatchObject({ delivered: true, workspaceId: "ws-A" });
    expect(sync).toHaveBeenCalledWith("/tmp/A", branch, { worktreePath: "/wt/A" });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      type: "ref_landed",
      payload: expect.objectContaining({ workspaceId: "ws-A", projectId: "proj-A" }),
    }));
    dispose();
  });
});
