import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildDependencyVolumes,
  dependencyVolumeName,
  deriveDependencyDirs,
  parseJsonc,
  predictRemoteWorkspaceFolder,
  sameHostPath,
  workspaceVolumePrefix,
} from "../src/lib/container-dep-volumes.js";

let worktree: string;

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), "dep-volumes-"));
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

describe("deriveDependencyDirs", () => {
  it("derives node_modules from a package.json", () => {
    writeFileSync(join(worktree, "package.json"), "{}");
    expect(deriveDependencyDirs({ worktreePath: worktree })).toEqual(["node_modules"]);
  });

  it("derives .venv for a Python project", () => {
    writeFileSync(join(worktree, "pyproject.toml"), "[project]");
    expect(deriveDependencyDirs({ worktreePath: worktree })).toEqual([".venv"]);
  });

  it("derives target for a Rust project", () => {
    writeFileSync(join(worktree, "Cargo.toml"), "[package]");
    expect(deriveDependencyDirs({ worktreePath: worktree })).toEqual(["target"]);
  });

  it("returns nothing for a stack whose caches live outside the worktree", () => {
    // Go's module cache is in GOPATH, Gradle's in GRADLE_USER_HOME — neither is in
    // the tree, so neither needs (or can use) a worktree-relative volume.
    writeFileSync(join(worktree, "go.mod"), "module example.com/x");
    expect(deriveDependencyDirs({ worktreePath: worktree })).toEqual([]);
  });

  it("prefers the project's configured symlinkDirs over marker detection", () => {
    writeFileSync(join(worktree, "package.json"), "{}");
    expect(
      deriveDependencyDirs({ worktreePath: worktree, symlinkDirs: '["vendor"]' }),
    ).toEqual(["vendor"]);
  });

  it("accepts symlinkDirs already parsed into an array", () => {
    expect(
      deriveDependencyDirs({ worktreePath: worktree, symlinkDirs: ["node_modules"] }),
    ).toEqual(["node_modules"]);
  });

  it("expands a pnpm workspace monorepo into its per-package node_modules", () => {
    // Under a strict linker the packages resolve from their OWN node_modules, so
    // relocating only the root would leave the bulk of the files on the bind mount
    // and fix neither the flake nor the I/O tax.
    writeFileSync(join(worktree, "package.json"), "{}");
    writeFileSync(join(worktree, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    for (const pkg of ["server", "shared"]) {
      mkdirSync(join(worktree, "packages", pkg, "node_modules"), { recursive: true });
    }

    expect(deriveDependencyDirs({ worktreePath: worktree })).toEqual([
      "node_modules",
      "packages/server/node_modules",
      "packages/shared/node_modules",
    ]);
  });

  it("ignores a traversal attempt in configured dirs", () => {
    expect(
      deriveDependencyDirs({ worktreePath: worktree, symlinkDirs: '["../../etc"]' }),
    ).toEqual([]);
  });
});

describe("dependencyVolumeName", () => {
  it("is deterministic, so re-provisioning reattaches the warm volume", () => {
    expect(dependencyVolumeName("ws-1", "node_modules")).toBe(
      dependencyVolumeName("ws-1", "node_modules"),
    );
  });

  it("scopes by workspace so branches never share a dependency tree", () => {
    expect(dependencyVolumeName("ws-1", "node_modules")).not.toBe(
      dependencyVolumeName("ws-2", "node_modules"),
    );
  });

  it("sanitizes separators into a legal docker volume name", () => {
    const name = dependencyVolumeName("ws-1", "packages/server/node_modules");
    expect(name).toBe("agentic-kanban-deps-ws-1-packages-server-node_modules");
    expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  });

  it("carries the workspace prefix used for teardown matching", () => {
    expect(dependencyVolumeName("ws-1", "node_modules").startsWith(workspaceVolumePrefix("ws-1"))).toBe(true);
  });

  it("does not let one workspace's prefix match another's volumes", () => {
    // `ws-1` must not match `ws-10`'s volumes during teardown.
    expect(dependencyVolumeName("ws-10", "node_modules").startsWith(workspaceVolumePrefix("ws-1"))).toBe(false);
  });
});

describe("buildDependencyVolumes", () => {
  it("maps each relative dir to a container path under the workspace folder", () => {
    expect(
      buildDependencyVolumes("ws-1", ["node_modules", "packages/server/node_modules"], "/workspaces/app"),
    ).toEqual([
      {
        name: "agentic-kanban-deps-ws-1-node_modules",
        relPath: "node_modules",
        containerPath: "/workspaces/app/node_modules",
      },
      {
        name: "agentic-kanban-deps-ws-1-packages-server-node_modules",
        relPath: "packages/server/node_modules",
        containerPath: "/workspaces/app/packages/server/node_modules",
      },
    ]);
  });

  it("tolerates a trailing slash on the workspace folder", () => {
    expect(buildDependencyVolumes("ws-1", ["node_modules"], "/workspaces/app/")[0]!.containerPath).toBe(
      "/workspaces/app/node_modules",
    );
  });
});

describe("predictRemoteWorkspaceFolder", () => {
  it("defaults to the spec's /workspaces/<basename>", () => {
    expect(predictRemoteWorkspaceFolder(worktree)).toBe(`/workspaces/${worktree.split(/[\\/]/).pop()}`);
  });

  it("honours an explicit workspaceFolder in .devcontainer/devcontainer.json", () => {
    mkdirSync(join(worktree, ".devcontainer"));
    writeFileSync(
      join(worktree, ".devcontainer", "devcontainer.json"),
      JSON.stringify({ image: "x", workspaceFolder: "/srv/app" }),
    );
    expect(predictRemoteWorkspaceFolder(worktree)).toBe("/srv/app");
  });

  it("reads a JSONC config with comments and trailing commas", () => {
    mkdirSync(join(worktree, ".devcontainer"));
    writeFileSync(
      join(worktree, ".devcontainer", "devcontainer.json"),
      ['{', '  // the image', '  "image": "node:20",', '  "workspaceFolder": "/srv/app",', '}'].join("\n"),
    );
    expect(predictRemoteWorkspaceFolder(worktree)).toBe("/srv/app");
  });

  it("falls back to the default when the config is unparseable", () => {
    mkdirSync(join(worktree, ".devcontainer"));
    writeFileSync(join(worktree, ".devcontainer", "devcontainer.json"), "{ not json");
    expect(predictRemoteWorkspaceFolder(worktree)).toBe(`/workspaces/${worktree.split(/[\\/]/).pop()}`);
  });
});

describe("sameHostPath", () => {
  // Found by live verification: the devcontainer CLI stamped
  // `devcontainer.local_folder=c:\projects\andrena\exp\taskflow` for a worktree the
  // board knows as `C:/projects/andrena/exp/taskflow`. Docker's exact
  // `--filter label=<path>` matched nothing, so teardown removed no container and
  // every dependency volume then failed to delete with "volume is in use".
  it.runIf(process.platform === "win32")(
    "matches the CLI's lowercased, backslash-separated label on Windows",
    () => {
      expect(
        sameHostPath("c:\\projects\\andrena\\exp\\taskflow", "C:/projects/andrena/exp/taskflow"),
      ).toBe(true);
    },
  );

  it("ignores a trailing separator", () => {
    expect(sameHostPath("/workspaces/app/", "/workspaces/app")).toBe(true);
  });

  it("does not match a different path", () => {
    expect(sameHostPath("/workspaces/app", "/workspaces/other")).toBe(false);
  });

  it.runIf(process.platform !== "win32")("stays case-sensitive on POSIX", () => {
    expect(sameHostPath("/home/Alice/app", "/home/alice/app")).toBe(false);
  });
});

describe("parseJsonc", () => {
  it("strips line and block comments", () => {
    expect(parseJsonc('{ /* a */ "x": 1 // b\n }')).toEqual({ x: 1 });
  });

  it("keeps comment-like sequences inside strings", () => {
    expect(parseJsonc('{ "url": "https://example.com/a" }')).toEqual({
      url: "https://example.com/a",
    });
  });

  it("does not terminate a string on an escaped quote", () => {
    expect(parseJsonc('{ "q": "say \\"hi\\" // not a comment" }')).toEqual({
      q: 'say "hi" // not a comment',
    });
  });

  it("tolerates trailing commas", () => {
    expect(parseJsonc('{ "a": [1, 2,], }')).toEqual({ a: [1, 2] });
  });
});
