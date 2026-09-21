import { afterEach, describe, expect, it } from "vitest";
import type { RepoLockAttempt } from "@agentic-kanban/shared/lib/repo-lock";
import { formatHolderLivenessEvidence } from "../services/merge-queue-repo-lock.js";
import {
  isMergeTrainLabelLive,
  registerLiveMergeTrain,
  resetLiveMergeTrainRegistryForTests,
  unregisterLiveMergeTrain,
} from "../services/merge-train-live-registry.js";

/**
 * #1150 — a contended repo-lock wait names the CURRENT holder's own job liveness, not just the
 * lock file's pid. A pid stays alive for as long as the whole server is up, so it says nothing
 * about whether the specific train job that acquired the lock is still running; the live
 * registry (keyed by label, which is all a `merge-train:<label>` holder string carries) does.
 */
const contended = (holder: string): RepoLockAttempt => ({
  outcome: "contended",
  reason: `held by pid 4242 (${holder})`,
  heldBy: { pid: 4242, hostname: "box", holder, acquiredAt: "2026-09-21T10:00:00.000Z", heartbeatAt: "2026-09-21T10:05:00.000Z" },
});

const trainLiveness = (holder: string): boolean | undefined => {
  const match = /^merge-train:(.+)$/.exec(holder);
  return match ? isMergeTrainLabelLive(match[1]) : undefined;
};

describe("repo-lock wait log names the holder's job liveness (#1150)", () => {
  afterEach(() => {
    resetLiveMergeTrainRegistryForTests();
  });

  it("says the holder's train job IS still running while its label is registered live", () => {
    registerLiveMergeTrain({ trainId: "t1", label: "train/2026-09-21-01", projectId: "p1" });
    expect(formatHolderLivenessEvidence(contended("merge-train:train/2026-09-21-01"), trainLiveness))
      .toContain("IS still running in this process");
  });

  it("calls a holder whose train is NOT registered a stranded lock the reconciler should reclaim", () => {
    registerLiveMergeTrain({ trainId: "t1", label: "train/2026-09-21-01", projectId: "p1" });
    unregisterLiveMergeTrain("t1");
    expect(formatHolderLivenessEvidence(contended("merge-train:train/2026-09-21-01"), trainLiveness))
      .toContain("NOT registered as running in this process");
  });

  it("adds nothing for a holder it cannot judge (a per-workspace queue member) or when no check is wired", () => {
    expect(formatHolderLivenessEvidence(contended("merge-queue:ws-1"), trainLiveness)).toBe("");
    expect(formatHolderLivenessEvidence(contended("merge-train:train/x"), undefined)).toBe("");
  });

  it("adds nothing when the attempt carries no holder (a race lost without lock contents)", () => {
    const attempt: RepoLockAttempt = { outcome: "contended", reason: "lost the race to another acquirer (EEXIST)" };
    expect(formatHolderLivenessEvidence(attempt, trainLiveness)).toBe("");
  });
});
