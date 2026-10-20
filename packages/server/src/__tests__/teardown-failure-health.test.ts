/**
 * #1657 — a teardownScript that fails run after run raises a project-health warning, and a
 * POSIX teardown script is routed through Git Bash on Windows (never cmd.exe).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { projects } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { getProjectHealth } from "../services/project-health.service.js";
import {
  recordTeardownResult,
  teardownFailureWarning,
  resetTeardownFailuresForTest,
  TEARDOWN_FAILURE_WARN_THRESHOLD,
} from "../services/teardown-failure-tracker.js";
import { findGitBash, runScript } from "../services/script-runner.js";
import { teardownWorktree } from "../services/workspace-teardown.service.js";

const SCRIPT = 'rm -rf "$KANBAN_WORKTREE_DIR/node_modules" || true';

describe("teardown failure streak (#1657)", () => {
  beforeEach(() => resetTeardownFailuresForTest());

  it("warns only after N consecutive failures, and a success resets the streak", () => {
    for (let i = 0; i < TEARDOWN_FAILURE_WARN_THRESHOLD - 1; i++) recordTeardownResult(SCRIPT, false, "rm not found");
    expect(teardownFailureWarning(SCRIPT)).toBeNull();
    recordTeardownResult(SCRIPT, false, "rm not found");
    expect(teardownFailureWarning(SCRIPT)).toContain("failed 3 times in a row");
    recordTeardownResult(SCRIPT, true);
    expect(teardownFailureWarning(SCRIPT)).toBeNull();
  });

  it("teardownWorktree feeds the tracker and project health shows the warning", async () => {
    const { db } = createTestDb();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId, name: "P", repoPath: "C:/nonexistent-repo", repoName: "repo",
      defaultBranch: "master", teardownScript: SCRIPT, createdAt: now, updatedAt: now,
    });
    const deps = {
      killDir: async () => 0,
      killPorts: async () => 0,
      killSupervisor: async () => 0,
      runScript: vi.fn(async () => ({ ok: false, output: "rm not found" })),
    };
    for (let i = 0; i < TEARDOWN_FAILURE_WARN_THRESHOLD; i++) {
      await teardownWorktree(
        { workingDir: "C:/x/.worktrees/feature_ak-1-a", teardownScript: SCRIPT, label: "merge" },
        deps,
      );
    }
    const entry = (await getProjectHealth(db)).projects.find((p) => p.id === projectId);
    expect(entry!.warnings.some((w) => w.includes("Teardown script failed"))).toBe(true);
    // teardown requests POSIX execution
    expect(deps.runScript.mock.calls[0][4]).toEqual({ posix: true });
  });
});

describe("runScript POSIX shell selection (#1657)", () => {
  it("findGitBash honours the KANBAN_GIT_BASH override and returns null when absent", () => {
    expect(findGitBash({ KANBAN_GIT_BASH: "D:/bash.exe" }, (p) => p === "D:/bash.exe")).toBe("D:/bash.exe");
    expect(findGitBash({}, () => false)).toBeNull();
  });

  it("on non-Windows platforms posix scripts use the default shell", async () => {
    const r = await runScript("echo hi", process.cwd(), "t", {}, { posix: true, platform: "linux", gitBash: "nope" });
    // Falls through to the platform shell (not the bogus bash path), so it succeeds where `echo` exists.
    expect(r.ok).toBe(true);
  });
});
