import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression tests for #155: the setup-path devcontainer provision call used to
 * pass NO profile at all, so with a setup script the container was created (and
 * frozen, since `devcontainer up` reuses an existing container and creation-time
 * mounts win) with the DEFAULT profile mount — silently running the builder
 * unauthenticated whenever a non-default/subscription profile was in play.
 */

vi.mock("@agentic-kanban/shared/lib/docker-exec", () => ({
  dockerExec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
}));

vi.mock("@agentic-kanban/shared/lib/devcontainer-exec", () => ({
  devcontainerAvailable: vi.fn(async () => true),
  hasDevcontainerConfig: vi.fn(() => true),
  devcontainerUp: vi.fn(async () => ({
    containerId: "freshcontainer123",
    remoteUser: "node",
    remoteWorkspaceFolder: "/workspaces/wt",
  })),
  formatMount: (m: { type?: string; source: string; target: string }) =>
    `type=${m.type ?? "bind"},source=${m.source},target=${m.target}`,
}));

vi.mock("@agentic-kanban/shared/lib/git-exec", () => ({
  gitExec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
}));

vi.mock("../services/mcp-http-bridge.service.js", () => ({
  ensureMcpHttpBridge: vi.fn(async () => undefined),
}));

vi.mock("../services/container-profile.service.js", () => ({
  HOST_GATEWAY_HOSTNAME: "host.docker.internal",
  provisionContainerProfile: vi.fn((opts: { profileKey: string }) => ({
    hostDir: `/profiles/${opts.profileKey}`,
    seeded: [],
  })),
  transcriptMount: vi.fn(() => ({
    source: "/host/transcripts",
    target: "/home/node/.claude/projects/x",
  })),
  writeContainerMcpConfig: vi.fn(() => "/tmp/mcp-config.json"),
}));

import { dockerExec as dockerExecMock } from "@agentic-kanban/shared/lib/docker-exec";
import { devcontainerUp as devcontainerUpMock } from "@agentic-kanban/shared/lib/devcontainer-exec";
import { provisionContainerProfile as provisionContainerProfileMock } from "../services/container-profile.service.js";
import { provisionContainerForWorkspace, findStaleProfileContainers } from "../services/devcontainer-workspace.service.js";

const WORKTREE = "/worktrees/wt";

/** No containers currently up for this worktree. */
function mockNoExistingContainers() {
  (dockerExecMock as any).mockImplementation(async (args: string[]) => {
    if (args[0] === "ps") return { stdout: "", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  });
}

/** One container already up, mounted with `staleProfileHostDir` as its `.claude` source. */
function mockExistingContainer(containerId: string, staleProfileHostDir: string) {
  (dockerExecMock as any).mockImplementation(async (args: string[]) => {
    if (args[0] === "ps") {
      return { stdout: `${containerId}\t${WORKTREE}`, stderr: "", code: 0 };
    }
    if (args[0] === "inspect") {
      const mounts = [{ Destination: "/home/node/.claude", Source: staleProfileHostDir }];
      return { stdout: JSON.stringify(mounts), stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  });
}

describe("provisionContainerForWorkspace — profile mount parity (#155)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("setup-script + non-default profile: container provisioned with the correct profile dir", async () => {
    mockNoExistingContainers();

    const result = await provisionContainerForWorkspace({
      enabled: true,
      worktreePath: WORKTREE,
      workspaceId: "ws1",
      claudeProfile: "myprofile",
    });

    expect(result).toBeDefined();
    // The narrow profile was seeded for the RESOLVED profile, not "default".
    expect(provisionContainerProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({ profileKey: "myprofile" }),
    );
    // The mount actually passed to `devcontainer up` points at that profile's dir.
    const upCall = (devcontainerUpMock as any).mock.calls[0];
    const mounts = upCall[1].mounts as Array<{ source: string; target: string }>;
    expect(mounts.some((m) => m.source === "/profiles/myprofile")).toBe(true);
  });

  it("passes the workspaceId through so concurrent workspaces on one profile get separate copies (#157)", async () => {
    mockNoExistingContainers();

    await provisionContainerForWorkspace({
      enabled: true,
      worktreePath: WORKTREE,
      workspaceId: "ws1",
      claudeProfile: "myprofile",
    });

    expect(provisionContainerProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({ profileKey: "myprofile", workspaceId: "ws1" }),
    );
  });

  it("no profile passed: falls back to the default profile dir (the pre-fix behavior for comparison)", async () => {
    mockNoExistingContainers();

    await provisionContainerForWorkspace({
      enabled: true,
      worktreePath: WORKTREE,
      workspaceId: "ws1",
    });

    expect(provisionContainerProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({ profileKey: "default" }),
    );
  });

  it("detects a container mounted with a DIFFERENT profile than expected", async () => {
    mockExistingContainer("stale123", "/profiles/default");

    const stale = await findStaleProfileContainers(WORKTREE, "/profiles/myprofile");

    expect(stale).toEqual(["stale123"]);
  });

  it("does NOT flag a container already mounted with the expected profile", async () => {
    mockExistingContainer("current123", "/profiles/myprofile");

    const stale = await findStaleProfileContainers(WORKTREE, "/profiles/myprofile");

    expect(stale).toEqual([]);
  });

  it("mismatch: recreates the stale container instead of silently reusing it", async () => {
    mockExistingContainer("stale123", "/profiles/default");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await provisionContainerForWorkspace({
      enabled: true,
      worktreePath: WORKTREE,
      workspaceId: "ws1",
      claudeProfile: "myprofile",
    });

    // Loud, not silent: a warning names the stale container and the reason.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("stale123"));
    // The stale container was removed rather than reused.
    expect((dockerExecMock as any).mock.calls.map((call: unknown[]) => call[0])).toContainEqual([
      "rm",
      "-f",
      "stale123",
    ]);
    // `devcontainer up` still ran afterwards and produced a fresh container.
    expect(result?.provision?.handle.containerId).toBe("freshcontainer123");

    warnSpy.mockRestore();
  });
});
