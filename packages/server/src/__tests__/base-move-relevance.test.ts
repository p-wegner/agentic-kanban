/**
 * A passed gate whose base moved during the run by verdict-neutral paths only keeps its verdict,
 * re-keyed to the new base; every other base move, and every failure to list the paths, still
 * discards it (#243). Measured trigger: three Bullseye saves on 2026-09-26 that committed only
 * `scripts/board-monitor/objective.md` discarded passes of 2463 s, 1489 s and 1508 s.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Database } from "../db/index.js";
import type { MergeGateShas } from "../services/pre-merge-gate.service.js";
import {
  assessBaseMove,
  classifyBaseMove,
  isVerdictNeutralPath,
} from "../services/base-move-relevance.js";
import { gateEvidenceShas, runGateWithEvidence } from "../services/merge-gate-evidence.js";

vi.mock("../repositories/merge-gate-discard.repository.js", () => ({
  recordMergeGateDiscard: vi.fn(async () => undefined),
}));

const OBJECTIVE = "scripts/board-monitor/objective.md";

describe("isVerdictNeutralPath", () => {
  it.each([
    OBJECTIVE,
    "CONTINUE.md",
    "BACKLOG.md",
    "docs/state.md",
    "docs/proposals/2026-09-27-x.md",
    "docs/learnings/shot.png",
    "docs\\analysis\\a.md",
  ])("accepts %s", (p) => expect(isVerdictNeutralPath(p)).toBe(true));

  it.each([
    "CLAUDE.md",
    "AGENTS.md",
    "README.md",
    "packages/server/CLAUDE.md",
    ".claude/skills/dev-server/SKILL.md",
    ".codex/hooks.json",
    "packages/server/skills/agentic-kanban/SKILL.md",
    "docs/env-vars.md",
    "docs/worker-fleet.md",
    "docs/agent-guide/pre-merge-gate.md",
    "docs/decisions/012-worker-fleet-compute-model.md",
    "docs/tests/durations.json",
    "docs/proposals/tool.mjs",
    "docs/proposals/data.json",
    "docs/proposals/../../packages/x.md",
    "scripts/board-monitor/loop.sh",
    "packages/server/src/index.ts",
    "\"docs/proposals/\\303\\244.md\"",
  ])("rejects %s", (p) => expect(isVerdictNeutralPath(p)).toBe(false));
});

describe("classifyBaseMove", () => {
  it("keeps a verdict when only objective.md moved and the branch does not touch it", () => {
    const d = classifyBaseMove({ movedPaths: [OBJECTIVE], branchPaths: ["packages/server/src/a.ts"] });
    expect(d.keep).toBe(true);
    expect(d.reason).toContain(OBJECTIVE);
  });

  it("discards when any moved path is a gate input, and names it", () => {
    const d = classifyBaseMove({ movedPaths: [OBJECTIVE, "packages/server/src/b.ts"], branchPaths: [] });
    expect(d).toEqual({ keep: false, reason: expect.stringContaining("packages/server/src/b.ts") });
  });

  it("discards when the branch changes a moved path too", () => {
    const d = classifyBaseMove({ movedPaths: [OBJECTIVE], branchPaths: [OBJECTIVE, "x.ts"] });
    expect(d.keep).toBe(false);
    expect(d.reason).toContain("branch also changes");
  });

  it("fails closed on an unknown or empty moved list, or an unknown branch list", () => {
    expect(classifyBaseMove({ movedPaths: null, branchPaths: [] }).keep).toBe(false);
    expect(classifyBaseMove({ movedPaths: [], branchPaths: [] }).keep).toBe(false);
    expect(classifyBaseMove({ movedPaths: [OBJECTIVE], branchPaths: null }).keep).toBe(false);
  });
});

describe("assessBaseMove", () => {
  it("fails closed without a worktree, a branch sha, or when a reader throws", async () => {
    const ok = async () => [OBJECTIVE];
    expect((await assessBaseMove({ cwd: null, baseBefore: "a", baseAfter: "b", branchSha: "c", readMoved: ok, readBranch: ok })).keep).toBe(false);
    expect((await assessBaseMove({ cwd: "/w", baseBefore: "a", baseAfter: "b", branchSha: null, readMoved: ok, readBranch: async () => [] })).keep).toBe(false);
    const boom = async (): Promise<string[] | null> => { throw new Error("git gone"); };
    expect((await assessBaseMove({ cwd: "/w", baseBefore: "a", baseAfter: "b", branchSha: "c", readMoved: boom, readBranch: async () => [] })).keep).toBe(false);
  });

  it("passes the pinned shas to the readers", async () => {
    const readMoved = vi.fn(async () => [OBJECTIVE]);
    const readBranch = vi.fn(async () => ["src/x.ts"]);
    const a = await assessBaseMove({ cwd: "/w", baseBefore: "b1", baseAfter: "b2", branchSha: "t1", readMoved, readBranch });
    expect(a.keep).toBe(true);
    expect(readMoved).toHaveBeenCalledWith("/w", "b1", "b2");
    expect(readBranch).toHaveBeenCalledWith("/w", "b1", "t1");
  });
});

describe("runGateWithEvidence across a base move", () => {
  afterEach(() => vi.restoreAllMocks());

  function run(after: MergeGateShas, movedFiles: string[] | null, branchFiles: string[] | null = ["src/x.ts"]) {
    const reads: MergeGateShas[] = [{ branchSha: "tip", baseSha: "base-1" }, after];
    let i = 0;
    return runGateWithEvidence({
      workspace: { id: "ws-bm", workingDir: "/repo/.worktrees/ws-bm", baseBranch: "master" },
      projectId: "p",
      source: "review-exit gate",
      database: {} as Database,
      readShas: async () => reads[Math.min(i++, 1)],
      runGate: async () => ({ passed: true, ran: true, stage: "verify" as const, message: "ok" }),
      readBaseMoveFiles: async () => movedFiles,
      readBranchFiles: async () => branchFiles,
    });
  }

  it("keeps a pass across an objective.md-only base move and keys the evidence to the new base", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const gate = await run({ branchSha: "tip", baseSha: "base-2" }, [OBJECTIVE]);
    expect(gate.moved).toBeNull();
    expect(gate.token).not.toBeNull();
    expect(gate.token).toMatchObject({ kind: "already-passed" });
    expect(JSON.stringify(gate.token)).toContain("base-2");
    expect(gate.shasBefore).toEqual({ branchSha: "tip", baseSha: "base-1" });
    expect(gateEvidenceShas(gate)).toEqual({ branchSha: "tip", baseSha: "base-2" });
    expect(gate.baseMoveKept).toEqual({ from: "base-1", to: "base-2", paths: [OBJECTIVE] });
    expect(log.mock.calls.flat().join("\n")).toContain(`KEPT although base base-1 -> base-2`);
    expect(log.mock.calls.flat().join("\n")).toContain(OBJECTIVE);
  });

  it("discards a pass when the base move touched code", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gate = await run({ branchSha: "tip", baseSha: "base-2" }, [OBJECTIVE, "packages/server/src/y.ts"]);
    expect(gate.moved).toBe("base");
    expect(gate.token).toBeNull();
    expect(gate.baseMoveKept).toBeNull();
    expect(gateEvidenceShas(gate)).toEqual({ branchSha: "tip", baseSha: "base-1" });
  });

  it("discards when the moved paths cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gate = await run({ branchSha: "tip", baseSha: "base-2" }, null);
    expect(gate.moved).toBe("base");
    expect(gate.token).toBeNull();
  });

  it("never keeps across a BRANCH move, even when the base moved by docs only", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gate = await run({ branchSha: "tip-2", baseSha: "base-2" }, [OBJECTIVE]);
    expect(gate.moved).toBe("branch");
    expect(gate.token).toBeNull();
  });
});
