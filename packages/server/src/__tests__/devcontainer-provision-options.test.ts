import { describe, it, expect } from "vitest";
import { resolveDevcontainerProvisionOptions } from "../services/devcontainer-workspace.service.js";

/**
 * #555: the setup-time and launch-time callers of `provisionContainerForWorkspace`
 * used to build `ProvisionOptions` by hand and disagreed about `strict` and about
 * gating `symlinkDirs` on the project's symlink `enabled` flag. Since
 * `devcontainer up` reuses a container whose CREATION-TIME mounts win, that drift
 * is a real defect class (#155/#577) — so the resolver's contract is pinned here.
 */
function prefs(map: Record<string, string>) {
  return async (key: string) => map[key] ?? null;
}

describe("resolveDevcontainerProvisionOptions (#555)", () => {
  it("returns null when devcontainer_builders is off, without resolving the project", async () => {
    let symlinkReads = 0;
    const options = await resolveDevcontainerProvisionOptions({
      worktreePath: "/tmp/wt",
      readPreference: prefs({}),
      resolveSymlink: async () => {
        symlinkReads += 1;
        return { enabled: true, dirs: ["node_modules"] };
      },
    });
    expect(options).toBeNull();
    expect(symlinkReads).toBe(0);
  });

  it("carries strict through from the preference", async () => {
    const options = await resolveDevcontainerProvisionOptions({
      worktreePath: "/tmp/wt",
      readPreference: prefs({ devcontainer_builders: "true", devcontainer_strict: "true" }),
    });
    expect(options).toMatchObject({ enabled: true, strict: true, worktreePath: "/tmp/wt" });
  });

  it("drops symlinkDirs when the project has dependency symlinks OFF", async () => {
    const options = await resolveDevcontainerProvisionOptions({
      worktreePath: "/tmp/wt",
      readPreference: prefs({ devcontainer_builders: "true" }),
      resolveSymlink: async () => ({ enabled: false, dirs: ["node_modules"] }),
    });
    expect(options?.symlinkDirs).toBeNull();
  });

  it("keeps symlinkDirs when the project has them ON", async () => {
    const options = await resolveDevcontainerProvisionOptions({
      worktreePath: "/tmp/wt",
      workspaceId: "ws-1",
      readPreference: prefs({ devcontainer_builders: "true" }),
      resolveSymlink: async () => ({ enabled: true, dirs: ["node_modules"] }),
    });
    expect(options?.symlinkDirs).toEqual(["node_modules"]);
    expect(options?.workspaceId).toBe("ws-1");
  });

  it("passes the launch profile through so both call sites mount the same one (#155)", async () => {
    const options = await resolveDevcontainerProvisionOptions({
      worktreePath: "/tmp/wt",
      readPreference: prefs({ devcontainer_builders: "true" }),
      profile: { claudeProfile: "work", claudeConfigDir: "/home/u/.claude-work", settingsProfile: "work" },
    });
    expect(options).toMatchObject({
      claudeProfile: "work",
      claudeConfigDir: "/home/u/.claude-work",
      settingsProfile: "work",
    });
  });
});
