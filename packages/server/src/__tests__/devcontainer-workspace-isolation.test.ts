import { describe, it, expect, beforeEach, vi } from "vitest";
import { provisionContainerForWorkspace, DevcontainerIsolationRefusedError } from "../services/devcontainer-workspace.service.js";

/**
 * #160: unit coverage for provisionContainerForWorkspace's downgrade-reason /
 * strict-mode contract, isolated from the session lifecycle. The devcontainer
 * CLI adapter is mocked so behavior is deterministic without real Docker.
 */
const hasDevcontainerConfig = vi.fn((..._args: unknown[]) => true);
const devcontainerAvailable = vi.fn(async (..._args: unknown[]) => false);
const devcontainerUp = vi.fn(async (..._args: unknown[]) => null);
vi.mock("@agentic-kanban/shared/lib/devcontainer-exec", () => ({
  hasDevcontainerConfig: (...args: unknown[]) => hasDevcontainerConfig(...args),
  devcontainerAvailable: (...args: unknown[]) => devcontainerAvailable(...args),
  devcontainerUp: (...args: unknown[]) => devcontainerUp(...args),
}));

describe("provisionContainerForWorkspace — isolation downgrade contract (#160)", () => {
  beforeEach(() => {
    hasDevcontainerConfig.mockReset().mockReturnValue(true);
    devcontainerAvailable.mockReset().mockResolvedValue(false);
    devcontainerUp.mockReset().mockResolvedValue(null);
  });

  it("returns no downgrade when the feature is off", async () => {
    const result = await provisionContainerForWorkspace({ enabled: false, worktreePath: "/tmp/wt" });
    expect(result).toEqual({});
    expect(hasDevcontainerConfig).not.toHaveBeenCalled();
  });

  it("returns no downgrade when the worktree declares no devcontainer", async () => {
    hasDevcontainerConfig.mockReturnValue(false);
    const result = await provisionContainerForWorkspace({ enabled: true, worktreePath: "/tmp/wt" });
    expect(result).toEqual({});
    expect(devcontainerAvailable).not.toHaveBeenCalled();
  });

  it("CLI missing: best-effort mode reports a downgrade reason instead of throwing", async () => {
    const result = await provisionContainerForWorkspace({ enabled: true, worktreePath: "/tmp/wt" });
    expect(result.provision).toBeUndefined();
    expect(result.downgradeReason).toMatch(/@devcontainers\/cli/i);
  });

  it("CLI missing: strict mode refuses instead of falling back", async () => {
    await expect(
      provisionContainerForWorkspace({ enabled: true, worktreePath: "/tmp/wt", strict: true }),
    ).rejects.toBeInstanceOf(DevcontainerIsolationRefusedError);
  });

  it("provisioning failure (devcontainer up fails): best-effort mode reports a downgrade reason", async () => {
    devcontainerAvailable.mockResolvedValue(true);
    devcontainerUp.mockResolvedValue(null);
    const result = await provisionContainerForWorkspace({ enabled: true, worktreePath: "/tmp/wt" });
    expect(result.provision).toBeUndefined();
    expect(result.downgradeReason).toMatch(/provisioning failed/i);
  });

  it("provisioning failure: strict mode refuses instead of falling back", async () => {
    devcontainerAvailable.mockResolvedValue(true);
    devcontainerUp.mockResolvedValue(null);
    await expect(
      provisionContainerForWorkspace({ enabled: true, worktreePath: "/tmp/wt", strict: true }),
    ).rejects.toBeInstanceOf(DevcontainerIsolationRefusedError);
  });
});
