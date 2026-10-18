import { describe, expect, it, vi } from "vitest";

const runAgentFix = vi.hoisted(() => vi.fn().mockResolvedValue({ attempt: { verdict: "agent_fix_red" } }));
vi.mock("../services/merge-train-agent-fix.js", async (orig) => ({ ...(await orig<object>()), runAgentFix }));

import { buildTrainOnRed } from "../services/merge-train-shepherd-wiring.js";
import { TrainShepherd } from "../services/merge-train-shepherd.js";

describe("train onRed after a missing-deps retry (#1573)", () => {
  const onRed = buildTrainOnRed({
    policy: { agentFix: true, strategy: "agent-fix", bisectAfter: false, caps: { timeoutMs: 1, maxTurns: 1 } } as never,
    shepherd: new TrainShepherd(vi.fn() as never), label: "t", attemptLabel: "t", baseBranch: "master",
    included: [], members: [], database: {} as never, placement: { projectId: "p", repoPath: "/r" },
  })!;
  const message = "Cannot find module 'x' (ERR_MODULE_NOT_FOUND)";

  it("a red that still names failing suites reaches the fix agent", async () => {
    const out = await onRed({ gateWorktree: "/w", message, failedSuites: ["a.test.ts"], regate: vi.fn() });
    expect(runAgentFix).toHaveBeenCalledTimes(1);
    expect(out).not.toBeNull();
  });

  it("a bare missing-deps failure with no suites is still declined", async () => {
    runAgentFix.mockClear();
    expect(await onRed({ gateWorktree: "/w", message, regate: vi.fn() })).toBeNull();
    expect(runAgentFix).not.toHaveBeenCalled();
  });
});
