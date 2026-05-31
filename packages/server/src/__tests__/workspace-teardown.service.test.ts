import { describe, it, expect, vi } from "vitest";
import { teardownWorktree } from "../services/workspace-teardown.service.js";
import { resolveWorktreeDevPorts } from "../services/worktree-ports.js";

describe("resolveWorktreeDevPorts", () => {
  it("maps an ak-<N> worktree to 3001+N / 5173+N", () => {
    expect(resolveWorktreeDevPorts("C:/andrena/.worktrees/feature_ak-42-foo")).toEqual({
      serverPort: 3043,
      clientPort: 5215,
    });
  });

  it("maps a feature_<N> worktree to 3001+N / 5173+N", () => {
    expect(resolveWorktreeDevPorts("C:/andrena/.worktrees/feature_7-bar")).toEqual({
      serverPort: 3008,
      clientPort: 5180,
    });
  });

  it("returns null for a non-worktree path (main checkout)", () => {
    expect(resolveWorktreeDevPorts("C:/andrena/agentic-kanban")).toBeNull();
  });

  it("uses a stable hash offset (101-1000) for non-numeric worktree branches", () => {
    const ports = resolveWorktreeDevPorts("C:/andrena/.worktrees/spike-thing");
    expect(ports).not.toBeNull();
    expect(ports!.serverPort).toBeGreaterThanOrEqual(3001 + 101);
    expect(ports!.serverPort).toBeLessThanOrEqual(3001 + 1000);
    // deterministic
    expect(resolveWorktreeDevPorts("C:/andrena/.worktrees/spike-thing")).toEqual(ports);
  });
});

describe("teardownWorktree", () => {
  function deps() {
    return {
      killDir: vi.fn(async () => 1),
      killPorts: vi.fn(async () => 1),
      runScript: vi.fn(async () => ({ ok: true, output: "" })),
    };
  }

  it("is a no-op for direct workspaces (no worktree to tear down)", async () => {
    const d = deps();
    const r = await teardownWorktree(
      { workingDir: "C:/andrena/agentic-kanban", isDirect: true, label: "delete" },
      d,
    );
    expect(d.killDir).not.toHaveBeenCalled();
    expect(d.killPorts).not.toHaveBeenCalled();
    expect(d.runScript).not.toHaveBeenCalled();
    expect(r).toEqual({ killedInDir: 0, killedOnPorts: 0, scriptRan: false });
  });

  it("is a no-op when there is no workingDir", async () => {
    const d = deps();
    await teardownWorktree({ workingDir: null, label: "delete" }, d);
    expect(d.killDir).not.toHaveBeenCalled();
    expect(d.killPorts).not.toHaveBeenCalled();
  });

  it("kills dir procs and the worktree's exact dev ports for a worktree", async () => {
    const d = deps();
    await teardownWorktree(
      { workingDir: "C:/andrena/.worktrees/feature_ak-42-foo", branch: "feature/ak-42-foo", label: "merge" },
      d,
    );
    expect(d.killDir).toHaveBeenCalledWith("C:/andrena/.worktrees/feature_ak-42-foo");
    // exact ports only — 3043/5215 — never a range
    expect(d.killPorts).toHaveBeenCalledWith([3043, 5215]);
  });

  it("runs the generic teardownScript with worktree context env", async () => {
    const d = deps();
    await teardownWorktree(
      {
        workingDir: "C:/andrena/.worktrees/feature_ak-42-foo",
        branch: "feature/ak-42-foo",
        teardownScript: "docker compose down",
        label: "delete",
      },
      d,
    );
    expect(d.runScript).toHaveBeenCalledTimes(1);
    const [script, cwd, label, env] = d.runScript.mock.calls[0];
    expect(script).toBe("docker compose down");
    expect(cwd).toBe("C:/andrena/.worktrees/feature_ak-42-foo");
    expect(label).toBe("teardown:delete");
    expect(env).toMatchObject({
      KANBAN_WORKTREE_DIR: "C:/andrena/.worktrees/feature_ak-42-foo",
      KANBAN_WORKTREE_BRANCH: "feature/ak-42-foo",
      KANBAN_ISSUE_NUMBER: "42",
      KANBAN_WORKTREE_SERVER_PORT: "3043",
      KANBAN_WORKTREE_CLIENT_PORT: "5215",
    });
  });

  it("skips the teardownScript when setupEnabled is false but still does built-in cleanup", async () => {
    const d = deps();
    await teardownWorktree(
      {
        workingDir: "C:/andrena/.worktrees/feature_ak-42-foo",
        teardownScript: "docker compose down",
        setupEnabled: false,
        label: "delete",
      },
      d,
    );
    expect(d.runScript).not.toHaveBeenCalled();
    expect(d.killDir).toHaveBeenCalled();
    expect(d.killPorts).toHaveBeenCalled();
  });

  it("does not throw if a cleanup layer fails (best-effort)", async () => {
    const d = {
      killDir: vi.fn(async () => { throw new Error("boom"); }),
      killPorts: vi.fn(async () => 0),
      runScript: vi.fn(async () => ({ ok: true, output: "" })),
    };
    await expect(
      teardownWorktree({ workingDir: "C:/andrena/.worktrees/feature_ak-1-x", label: "delete" }, d),
    ).resolves.toBeTruthy();
    // port cleanup still attempted despite dir cleanup throwing
    expect(d.killPorts).toHaveBeenCalled();
  });
});
