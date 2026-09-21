/**
 * #1123 — a failed workspace setup script must not yield a Ready-to-merge branch when
 * `setup_blocking = 0`. `setupFailedBlocking` (#169) only refuses the LAUNCH, and only for a
 * project with `setup_blocking = 1`; `born-blocked-reconciler.ts`'s retry also requires
 * `setup_blocking = 1`. So a non-blocking failed setup has no recovery path at all — the
 * pre-merge gate is the last place that can still refuse the merge. That is
 * `describeFailedSetupRun`, called from `runPreMergeGate` right after the #628 install check.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getSetupRunMock = vi.fn();

vi.mock("../repositories/workspace-setup-run.repository.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repositories/workspace-setup-run.repository.js")>()),
  getSetupRunForGate: (...args: unknown[]) => getSetupRunMock(...args),
}));

const { describeFailedSetupRun } = await import("../services/pre-merge-gate-setup-failure.js");

const db = {} as never;

beforeEach(() => vi.clearAllMocks());

describe("describeFailedSetupRun (#1123)", () => {
  it("is a no-op when no setup run was ever recorded", async () => {
    getSetupRunMock.mockResolvedValue(undefined);
    expect(await describeFailedSetupRun("w1", db)).toBeNull();
  });

  it("is a no-op for a succeeded run", async () => {
    getSetupRunMock.mockResolvedValue({ state: "succeeded", command: "pnpm install -r", stderrTail: null, workingDir: null, endedAt: null });
    expect(await describeFailedSetupRun("w1", db)).toBeNull();
  });

  it("is a no-op for a skipped run (project with no setup script)", async () => {
    getSetupRunMock.mockResolvedValue({ state: "skipped", command: null, stderrTail: null, workingDir: null, endedAt: null });
    expect(await describeFailedSetupRun("w1", db)).toBeNull();
  });

  it("blocks on a failed run, naming the command, the last error, and when it was recorded", async () => {
    getSetupRunMock.mockResolvedValue({
      state: "failed",
      command: "pnpm install -r",
      stderrTail: "ERESOLVE could not resolve dependency tree",
      workingDir: null,
      endedAt: "2026-09-16T00:32:22.657Z",
    });
    const msg = await describeFailedSetupRun("w1", db);
    expect(msg).toContain("FAILED");
    expect(msg).toContain("pnpm install -r");
    expect(msg).toContain("ERESOLVE could not resolve dependency tree");
    expect(msg).toContain("could not have run a single test");
    expect(msg).toContain("2026-09-16T00:32:22.657Z");
    expect(msg).toContain("trusted without re-checking");
  });

  it("corroborates with an empty node_modules/.bin when the worktree confirms it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-setup-failure-"));
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    try {
      getSetupRunMock.mockResolvedValue({ state: "failed", command: "pnpm install -r", stderrTail: null, workingDir: dir, endedAt: null });
      const msg = await describeFailedSetupRun("w1", db);
      expect(msg).toContain("node_modules/.bin is empty");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("corroborates with an absent node_modules/.bin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-setup-failure-"));
    try {
      expect(existsSync(join(dir, "node_modules"))).toBe(false);
      getSetupRunMock.mockResolvedValue({ state: "failed", command: null, stderrTail: null, workingDir: dir, endedAt: null });
      const msg = await describeFailedSetupRun("w1", db);
      expect(msg).toContain("node_modules/.bin is absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #1175 — reproduces the stale-latch bug: a FAILED verdict from hours ago no longer reflects
  // the tree, which now plainly has its dependencies installed. The refusal must be LIFTED, not
  // just left uncorroborated.
  it("#1175: clears the block when node_modules/.bin now has entries, even though the stored verdict is FAILED", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-setup-failure-"));
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "vitest"), "");
    try {
      getSetupRunMock.mockResolvedValue({
        state: "failed",
        command: "pnpm install -r",
        stderrTail: "ERR_PNPM_UNKNOWN UNKNOWN: unknown error, stat '...'",
        workingDir: dir,
        endedAt: "2026-09-16T00:32:22.657Z",
      });
      expect(await describeFailedSetupRun("w1", db)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("degrades to no-op when the row cannot be read", async () => {
    getSetupRunMock.mockRejectedValue(new Error("db gone"));
    expect(await describeFailedSetupRun("w1", db)).toBeNull();
  });
});

describe("runPreMergeGate consults every real workspace's setup run (#1123)", () => {
  afterEach(() => vi.clearAllMocks());

  it("blocks a train when a MEMBER's setup run failed", async () => {
    const { runPreMergeGate } = await import("../services/pre-merge-gate.service.js");
    getSetupRunMock.mockImplementation((workspaceId: string) =>
      Promise.resolve(
        workspaceId === "ws-2"
          ? { state: "failed", command: "pnpm install -r", stderrTail: "boom", workingDir: null }
          : undefined,
      ),
    );

    const result = await runPreMergeGate(
      { id: "train:q1", workingDir: null, baseBranch: "main", memberWorkspaceIds: ["ws-1", "ws-2"] },
      "proj-1",
      db,
    );

    expect(result.passed).toBe(false);
    expect(result.message).toContain("dependency setup script FAILED");
    expect(getSetupRunMock.mock.calls.map((c) => c[0])).toContain("ws-2");
    expect(getSetupRunMock.mock.calls.map((c) => c[0])).not.toContain("train:q1");
  });

  it("falls back to the workspace's own id when no members are named", async () => {
    const { runPreMergeGate } = await import("../services/pre-merge-gate.service.js");
    getSetupRunMock.mockResolvedValue({ state: "failed", command: null, stderrTail: null, workingDir: null });

    const result = await runPreMergeGate({ id: "ws-9", workingDir: null, baseBranch: "main" }, "proj-1", db);

    expect(result.passed).toBe(false);
    expect(getSetupRunMock.mock.calls.map((c) => c[0])).toEqual(["ws-9"]);
  });
});
