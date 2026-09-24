/**
 * #1239 — a merge train never mixes bases. A heal workspace lands on its release candidate and
 * an ordinary one on master; `trainEligible` is where the queue decides a batch is "one repo,
 * one base", so an rc-based member among master-based ones sends the batch down the
 * per-ticket path, each merging into its OWN base, rather than assembling one train ref.
 */
import { describe, expect, it } from "vitest";
import { trainEligible } from "../services/merge-queue-train.js";
import type { MergeQueuePlan } from "../services/merge-queue.service.js";

type Member = MergeQueuePlan["order"][number];

function member(id: string, baseBranch: string, overrides: Partial<Member> = {}): Member {
  return {
    id,
    issueId: `issue-${id}`,
    issueNumber: Number(id.replace(/\D/g, "")) || null,
    branch: `feature/${id}`,
    workingDir: `/wt/${id}`,
    repoPath: "/repo",
    baseBranch,
    issueTitle: `ticket ${id}`,
    status: "idle",
    isDirect: false,
    changedFiles: [],
    ...overrides,
  };
}

describe("trainEligible refuses a batch that mixes bases (#1239)", () => {
  it("two master-based members ride one train", () => {
    expect(trainEligible([member("w1", "master"), member("w2", "master")])).toBe(true);
  });

  it("an rc-based heal among master-based members is not one train", () => {
    expect(trainEligible([member("w1", "master"), member("w2", "rc/20260925"), member("w3", "master")])).toBe(false);
  });

  it("two heals on the SAME rc may ride one train — into the rc", () => {
    expect(trainEligible([member("w1", "rc/20260925"), member("w2", "rc/20260925")])).toBe(true);
    expect(trainEligible([member("w1", "rc/20260925"), member("w2", "rc/20260926")])).toBe(false);
  });
});
