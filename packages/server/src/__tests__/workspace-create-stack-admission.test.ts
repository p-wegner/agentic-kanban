import { describe, it, expect, vi } from "vitest";
import { provisionServicesForLaunch } from "../services/workspace-create-stack.service.js";
import { workspaceServicesService } from "../services/workspace-services.service.js";
import type { Database } from "../db/index.js";

/**
 * #56 admission cap: provisionServicesForLaunch must DEFER (a clear, non-crying-wolf
 * state; agent still launches) rather than start an (N+1)th stack past
 * max_concurrent_stacks — checked at the single choke point, AFTER free adoption. These
 * exercise the gate with injected deps only (no DB, no docker).
 */

const ENABLED_CONFIG = JSON.stringify({ enabled: true, composeFile: "docker-compose.yml", ports: ["db"] });

const baseParams = {
  servicesConfigRaw: ENABLED_CONFIG,
  workspaceId: "ws-abc123def456",
  workspaceCreatedAt: new Date().toISOString(),
  branch: "feature/x",
  leadingWorktreePath: "/tmp/wt",
  siblings: [],
};

// A fake DB — never touched, because we always inject sharing/admission deps. The
// shared-worktree query runs first; stub it to "no sharers" via a resolved empty list.
const fakeDb = {} as Database;

describe("provisionServicesForLaunch admission cap (#56)", () => {
  it("defers when live stacks are AT the cap — no compose up, deferred flag set", async () => {
    const provisionSpy = vi.spyOn(workspaceServicesService, "provisionWorkspaceServices");
    // fakeDbWithNoSharers → no co-resident to adopt, so control reaches the admission gate.
    const result = await provisionServicesForLaunch(
      fakeDbWithNoSharers(),
      baseParams,
      { getMaxConcurrentStacks: async () => 3, countLiveStacks: async () => 3 },
    );
    expect(result).not.toBeNull();
    expect(result!.adopted).toBe(false);
    expect(result!.state.status).toBe("error");
    expect(result!.state.deferred).toBe(true);
    expect(result!.state.error).toMatch(/deferred/i);
    expect(provisionSpy).not.toHaveBeenCalled();
    provisionSpy.mockRestore();
  });

  it("does NOT defer below the cap — provisioning proceeds", async () => {
    const provisionSpy = vi
      .spyOn(workspaceServicesService, "provisionWorkspaceServices")
      .mockResolvedValue({ composeProjectName: "ak-i-ws-abc", ports: { db: 31000 }, envFilePath: "/tmp/wt/.kanban/services.env", status: "up", updatedAt: new Date().toISOString() });
    const result = await provisionServicesForLaunch(
      fakeDbWithNoSharers(),
      baseParams,
      { getMaxConcurrentStacks: async () => 3, countLiveStacks: async () => 2 },
    );
    expect(result!.state.status).toBe("up");
    expect(result!.state.deferred).toBeUndefined();
    expect(provisionSpy).toHaveBeenCalledOnce();
    provisionSpy.mockRestore();
  });

  it("cap 0 = unlimited — never defers regardless of live count", async () => {
    const provisionSpy = vi
      .spyOn(workspaceServicesService, "provisionWorkspaceServices")
      .mockResolvedValue({ composeProjectName: "ak-i-ws-abc", ports: {}, envFilePath: "", status: "up", updatedAt: new Date().toISOString() });
    const countSpy = vi.fn(async () => 999);
    const result = await provisionServicesForLaunch(
      fakeDbWithNoSharers(),
      baseParams,
      { getMaxConcurrentStacks: async () => 0, countLiveStacks: countSpy },
    );
    expect(result!.state.status).toBe("up");
    // cap 0 short-circuits before counting — the live count is never consulted.
    expect(countSpy).not.toHaveBeenCalled();
    provisionSpy.mockRestore();
  });
});

/**
 * A minimal fake Database whose select-chain resolves to no shared-worktree rows, so
 * resolveSharedWorktreeStack returns null and control reaches the admission gate.
 */
function fakeDbWithNoSharers(): Database {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve([]),
    then: (res: (rows: unknown[]) => unknown) => res([]),
  };
  return { select: () => chain } as unknown as Database;
}
