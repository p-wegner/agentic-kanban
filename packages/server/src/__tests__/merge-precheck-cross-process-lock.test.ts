/**
 * #764 — `mergeWorkspace`'s refuse/reuse pre-check must see a CROSS-PROCESS repo-lock
 * holder, not only this process's `activeMerges` map.
 *
 * Why the ordering matters (and why this is not a cosmetic message change). The pre-check
 * sits deliberately BEFORE the pre-lock verify gate; the comment at that gate call site says
 * why: "when another merge is already in flight this call is going to be refused anyway, and
 * gating first would burn a full test run to produce that refusal." The gate is 20-40 min on
 * this repo. Because the pre-check read only in-process state, a repo held by a Conductor
 * agent's git, a second server process surviving a hot-reload, or a human running git by hand
 * looked FREE — so the merge ran the whole gate and only then blocked inside
 * `acquireOnDiskRepoLock` for up to 90 minutes. `done-unmerged-invariant-sweep` was taught to
 * consult the on-disk lock for exactly this reason in #993; the operator-facing path was not.
 *
 * These cases pin the DECISION table, which is the part that can silently invert: refusing a
 * lock that is actually reclaimable would block merges on a holder nobody holds, which is the
 * failure mode #207 and #970 each had to walk back.
 */
import { describe, it, expect } from "vitest";
import { hostname } from "node:os";
import type { RepoLockStatus } from "@agentic-kanban/shared/lib/repo-lock";
import {
  describeCrossProcessMergeHolder,
  repoLockHolderFor,
} from "../services/workspace-merge-lock-precheck.js";

function lock(over: Partial<RepoLockStatus> & { holder?: string } = {}): RepoLockStatus {
  const { holder, ...rest } = over;
  return {
    path: "/repo/.git/agentic-kanban-merge.lock",
    contents: {
      pid: 4242,
      hostname: hostname(),
      holder: holder ?? "conductor:loop",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    },
    ageMs: 5_000,
    isStale: false,
    ownerProcessDead: false,
    ownerProcessAlive: false,
    ...rest,
  };
}

describe("describeCrossProcessMergeHolder (#764)", () => {
  it("refuses for a live holder in ANOTHER process — the case that used to burn a full verify gate", () => {
    const held = describeCrossProcessMergeHolder(lock({ holder: "conductor:loop" }), "ws-1");
    expect(held).not.toBeNull();
    expect(held?.holder).toBe("conductor:loop");
    expect(held?.pid).toBe(4242);
    expect(held?.ageMs).toBe(5_000);
  });

  it("proceeds when no lockfile exists", () => {
    expect(describeCrossProcessMergeHolder(null, "ws-1")).toBeNull();
  });

  it("proceeds when the holder is OUR OWN workspace", () => {
    // The in-memory refuse/reuse path above owns this case. Refusing here would turn a
    // leftover on-disk entry for this same workspace into a permanent refusal of its retry.
    const own = lock({ holder: repoLockHolderFor("ws-1") });
    expect(describeCrossProcessMergeHolder(own, "ws-1")).toBeNull();
    // ...but the same lock held for a DIFFERENT workspace is still a refusal.
    expect(describeCrossProcessMergeHolder(own, "ws-2")).not.toBeNull();
  });

  it("holder label matches what acquireOnDiskRepoLock stamps", () => {
    expect(repoLockHolderFor("ws-1")).toBe("workspace:ws-1");
  });

  it("proceeds when the same-host holder's pid is confirmed DEAD (reclaimable)", () => {
    // tryAcquireRepoLock reclaims this immediately (#207). Refusing would block every merge
    // on the repo behind a process that no longer exists.
    const dead = lock({ ownerProcessDead: true, isStale: false });
    expect(describeCrossProcessMergeHolder(dead, "ws-1")).toBeNull();
  });

  it("proceeds when the lock is STALE and not provably alive (normal recovery applies)", () => {
    const stale = lock({ isStale: true, ageMs: 10 * 60_000, ownerProcessAlive: false });
    expect(describeCrossProcessMergeHolder(stale, "ws-1")).toBeNull();
  });

  it("REFUSES a stale heartbeat whose pid is provably ALIVE", () => {
    // #970's lesson: reclaiming over a live holder is the more expensive mistake. A holder
    // mid-`git` that missed a heartbeat (blocked loop, AV-locked write, sleep/resume) is
    // still holding the repo.
    const staleButAlive = lock({ isStale: true, ageMs: 10 * 60_000, ownerProcessAlive: true });
    expect(describeCrossProcessMergeHolder(staleButAlive, "ws-1")).not.toBeNull();
  });

  it("dead beats alive when a fixture claims both (dead is the reclaimable direction)", () => {
    const both = lock({ ownerProcessDead: true, ownerProcessAlive: true, isStale: true });
    expect(describeCrossProcessMergeHolder(both, "ws-1")).toBeNull();
  });
});
