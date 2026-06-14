import { describe, it, expect } from "vitest";
import type { StackProfile } from "@agentic-kanban/shared";
import {
  runColdCloneBuildCheck,
  coldCloneCheckPrefKey,
} from "../services/cold-clone-build-check.service.js";

function profile(overrides: Partial<StackProfile> = {}): StackProfile {
  return {
    stack: "node",
    packageManager: "pnpm",
    isMonorepo: false,
    workspaces: [],
    installCommand: "pnpm install",
    buildCommand: "pnpm build",
    testCommand: null,
    quickTestCommand: null,
    lintCommand: null,
    typecheckCommand: null,
    devCommand: null,
    isWeb: false,
    devHealthUrl: null,
    devPort: null,
    testDir: null,
    testRunner: null,
    source: "detected",
    detectedMarkers: ["package.json"],
    updatedAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

const INPUT = { repoPath: "/repo", branch: "feature/ak-1-x" };

/** A runner stub recording every (cwd, script) it was asked to run. */
function recordingRunner(results: Record<string, { exitCode: number; stdout?: string; stderr?: string }>) {
  const calls: Array<{ cwd: string; script: string }> = [];
  const run = async (cwd: string, script: string) => {
    calls.push({ cwd, script });
    const r = results[script] ?? { exitCode: 0 };
    return { exitCode: r.exitCode, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls };
}

describe("coldCloneCheckPrefKey", () => {
  it("namespaces the preference per project", () => {
    expect(coldCloneCheckPrefKey("abc")).toBe("cold_clone_check_abc");
  });
});

describe("runColdCloneBuildCheck", () => {
  const noopClone = async () => {};
  const noopCleanup = async () => {};

  it("passes when install and build both exit 0", async () => {
    const { run, calls } = recordingRunner({});
    const res = await runColdCloneBuildCheck(INPUT, profile(), {
      runner: run,
      cloner: noopClone,
      cleanup: noopCleanup,
      tmpDir: "/tmp/clone",
    });
    expect(res.ok).toBe(true);
    expect(res.reason).toBe("passed");
    // install ran before build, both in the temp clone dir
    expect(calls).toEqual([
      { cwd: "/tmp/clone", script: "pnpm install" },
      { cwd: "/tmp/clone", script: "pnpm build" },
    ]);
  });

  it("FAILS when the build breaks on a fresh clone (the #783 / acceptance case)", async () => {
    const { run } = recordingRunner({
      "pnpm build": { exitCode: 1, stderr: "esbuild: missing native binary" },
    });
    const res = await runColdCloneBuildCheck(INPUT, profile(), {
      runner: run,
      cloner: noopClone,
      cleanup: noopCleanup,
      tmpDir: "/tmp/clone",
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("build-failed");
    expect(res.failedCommand).toBe("pnpm build");
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain("esbuild");
  });

  it("fails on a non-zero install and never reaches the build", async () => {
    const { run, calls } = recordingRunner({
      "pnpm install": { exitCode: 1, stderr: "ERR_PNPM_NO_OFFLINE" },
    });
    const res = await runColdCloneBuildCheck(INPUT, profile(), {
      runner: run,
      cloner: noopClone,
      cleanup: noopCleanup,
      tmpDir: "/tmp/clone",
    });
    expect(res.ok).toBe(false);
    expect(res.failedCommand).toBe("pnpm install");
    expect(calls.map((c) => c.script)).toEqual(["pnpm install"]); // build skipped
  });

  it("reports clone-failed without running install/build", async () => {
    const { run, calls } = recordingRunner({});
    const res = await runColdCloneBuildCheck(INPUT, profile(), {
      runner: run,
      cloner: async () => {
        throw new Error("fatal: branch not found");
      },
      cleanup: noopCleanup,
      tmpDir: "/tmp/clone",
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("clone-failed");
    expect(res.output).toContain("branch not found");
    expect(calls).toEqual([]);
  });

  it("is a no-op pass when no build command can be derived", async () => {
    const { run, calls } = recordingRunner({});
    const res = await runColdCloneBuildCheck(
      INPUT,
      profile({ buildCommand: null, testCommand: null }),
      { runner: run, cloner: noopClone, cleanup: noopCleanup, tmpDir: "/tmp/clone" },
    );
    expect(res.ok).toBe(true);
    expect(res.reason).toBe("no-build-command");
    expect(calls).toEqual([]); // nothing cloned or run
  });

  it("uses testCommand && buildCommand from the profile as the build gate", async () => {
    const { run, calls } = recordingRunner({});
    await runColdCloneBuildCheck(
      INPUT,
      profile({ testCommand: "pnpm test", buildCommand: "pnpm build" }),
      { runner: run, cloner: noopClone, cleanup: noopCleanup, tmpDir: "/tmp/clone" },
    );
    expect(calls.map((c) => c.script)).toContain("pnpm test && pnpm build");
  });

  it("always cleans up the temp clone, even after a build failure", async () => {
    const cleaned: string[] = [];
    const { run } = recordingRunner({ "pnpm build": { exitCode: 2 } });
    await runColdCloneBuildCheck(INPUT, profile(), {
      runner: run,
      cloner: noopClone,
      cleanup: async (d) => {
        cleaned.push(d);
      },
      tmpDir: "/tmp/clone",
    });
    // cleanup called twice: once pre-clone (stale removal) + once in finally
    expect(cleaned.filter((d) => d === "/tmp/clone").length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to marker-rule derivation when no profile is set", async () => {
    // null profile with a non-node repoPath that derives nothing → no-op pass
    const { run } = recordingRunner({});
    const res = await runColdCloneBuildCheck(
      { repoPath: "/nonexistent-empty-repo", branch: "main" },
      null,
      { runner: run, cloner: noopClone, cleanup: noopCleanup, tmpDir: "/tmp/clone" },
    );
    expect(res.ok).toBe(true);
    expect(res.reason).toBe("no-build-command");
  });
});
