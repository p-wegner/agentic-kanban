import { describe, it, expect, vi, beforeEach } from "vitest";

const teardownWorkspaceServices = vi.fn(async () => {});
const reapWorkspaceContainer = vi.fn(async () => {});

vi.mock("../services/workspace-services.service.js", () => ({
  workspaceServicesService: {
    get teardownWorkspaceServices() {
      return teardownWorkspaceServices;
    },
  },
  parseStoredComposeProjectName: (state?: string | null) => {
    if (!state) return null;
    try {
      return (JSON.parse(state) as { composeProjectName?: string }).composeProjectName ?? null;
    } catch {
      return null;
    }
  },
}));

vi.mock("../services/devcontainer-workspace.service.js", () => ({
  reapWorkspaceContainer: (...args: unknown[]) => reapWorkspaceContainer(...(args as [])),
}));

const { releaseWorkspaceResources } = await import("../services/workspace-resource-release.js");

const stack = JSON.stringify({ composeProjectName: "ak-w1" });

describe("releaseWorkspaceResources (#549)", () => {
  beforeEach(() => {
    teardownWorkspaceServices.mockClear();
    reapWorkspaceContainer.mockClear();
    teardownWorkspaceServices.mockResolvedValue(undefined);
    reapWorkspaceContainer.mockResolvedValue(undefined);
  });

  it("releases stack then container for a worktree workspace", async () => {
    const order: string[] = [];
    teardownWorkspaceServices.mockImplementation(async () => void order.push("stack"));
    reapWorkspaceContainer.mockImplementation(async () => void order.push("container"));

    await releaseWorkspaceResources({ id: "w1", workingDir: "/wt/w1", serviceState: stack });

    expect(order).toEqual(["stack", "container"]);
    expect(teardownWorkspaceServices).toHaveBeenCalledWith({
      composeProjectName: "ak-w1",
      composeWorktreePath: "/wt/w1",
      releasedByWorkspaceId: "w1",
    });
    expect(reapWorkspaceContainer).toHaveBeenCalledWith({ worktreePath: "/wt/w1", workspaceId: "w1" });
  });

  it("is a no-op without a workingDir, and for a direct workspace", async () => {
    await releaseWorkspaceResources({ id: "w1", workingDir: null, serviceState: stack });
    await releaseWorkspaceResources({ id: "w2", workingDir: "/repo", isDirect: true, serviceState: stack });
    expect(teardownWorkspaceServices).not.toHaveBeenCalled();
    expect(reapWorkspaceContainer).not.toHaveBeenCalled();
  });

  it("still reaps the container when no stack was provisioned", async () => {
    await releaseWorkspaceResources({ id: "w3", workingDir: "/wt/w3", serviceState: null });
    expect(teardownWorkspaceServices).not.toHaveBeenCalled();
    expect(reapWorkspaceContainer).toHaveBeenCalledTimes(1);
  });

  it("a failing stack teardown never blocks the container reap", async () => {
    teardownWorkspaceServices.mockRejectedValue(new Error("docker down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(releaseWorkspaceResources({ id: "w4", workingDir: "/wt/w4", serviceState: stack }, { phase: "close" })).resolves.toBeUndefined();

    expect(reapWorkspaceContainer).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(" ")).toContain("close: service-stack teardown failed");
    warn.mockRestore();
  });

  it("a failing container reap is swallowed too", async () => {
    reapWorkspaceContainer.mockRejectedValue(new Error("no engine"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(releaseWorkspaceResources({ id: "w5", workingDir: "/wt/w5", serviceState: null })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("routes every step through an injected step wrapper", async () => {
    const seen: string[] = [];
    await releaseWorkspaceResources(
      { id: "w6", workingDir: "/wt/w6", serviceState: stack },
      {
        step: async (name, run) => {
          seen.push(name);
          return run();
        },
      },
    );
    expect(seen).toEqual(["teardown-service-stack", "reap-devcontainer"]);
  });
});
