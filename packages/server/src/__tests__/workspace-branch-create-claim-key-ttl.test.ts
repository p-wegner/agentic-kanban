// @covers workspaces.create.branch-create-claim [error]
//
// #719, the two properties the create-path integration test cannot show cheaply:
//  - the claim key is the WORKTREE PATH (every branch of issue N is one key), not the branch;
//  - a claim EXPIRES, so a create that hangs in `setupWorktree` cannot wedge
//    `409 BRANCH_CREATE_IN_FLIGHT` for the lifetime of the server process — which is what
//    #673's release-only-in-`finally` did.
// Pure unit test: the claim registry has no DB and no git, and the TTL is exercised through
// the injected `nowMs` rather than by waiting.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CLAIM_TTL_MS,
  claimBranchForCreate,
  isBranchCreateClaimed,
  releaseBranchForCreate,
  resetBranchCreateClaims,
} from "../services/workspace-branch-create-claim.js";

const ISSUE = "issue-uuid-1";
const OTHER_ISSUE = "issue-uuid-2";
const T0 = 1_700_000_000_000;

describe("worktree-create claim is keyed on the path, not the branch (#719)", () => {
  beforeEach(() => resetBranchCreateClaims());
  afterEach(() => {
    resetBranchCreateClaims();
    vi.restoreAllMocks();
  });

  it("refuses a second branch of the same issue — both resolve to the leaf ak-670", () => {
    expect(claimBranchForCreate(ISSUE, "feature/ak-670-monitor", { nowMs: T0 })).toBe(true);
    expect(claimBranchForCreate(ISSUE, "feature/ak-670-manual", { nowMs: T0 })).toBe(false);
    // …and the same branch, which is the #673 case, is still refused.
    expect(claimBranchForCreate(ISSUE, "feature/ak-670-monitor", { nowMs: T0 })).toBe(false);
  });

  it("releasing any branch of the issue frees the directory it was holding", () => {
    expect(claimBranchForCreate(ISSUE, "feature/ak-670-monitor", { nowMs: T0 })).toBe(true);
    // Release names the branch the CALLER claimed; the key it maps to is the leaf.
    releaseBranchForCreate(ISSUE, "feature/ak-670-monitor");
    expect(claimBranchForCreate(ISSUE, "feature/ak-670-manual", { nowMs: T0 })).toBe(true);
  });

  it("allows branches of one issue that resolve to DIFFERENT directories", () => {
    // No `ak-<n>` in the branch, so it keeps its own sanitized leaf instead of collapsing.
    expect(claimBranchForCreate(ISSUE, "feature/ak-670-monitor", { nowMs: T0 })).toBe(true);
    expect(claimBranchForCreate(ISSUE, "showdown/codex", { nowMs: T0 })).toBe(true);
  });

  it("does not let one issue's claim block another issue", () => {
    expect(claimBranchForCreate(ISSUE, "feature/ak-670-monitor", { nowMs: T0 })).toBe(true);
    expect(claimBranchForCreate(OTHER_ISSUE, "feature/ak-671-x", { nowMs: T0 })).toBe(true);
  });
});

describe("worktree-create claim expires so a hung create cannot wedge it (#719)", () => {
  beforeEach(() => resetBranchCreateClaims());
  afterEach(() => {
    resetBranchCreateClaims();
    vi.restoreAllMocks();
  });

  it("still refuses a second create while the claim is inside its TTL", () => {
    expect(claimBranchForCreate(ISSUE, "feature/ak-670-a", { nowMs: T0 })).toBe(true);
    expect(claimBranchForCreate(ISSUE, "feature/ak-670-b", { nowMs: T0 + CLAIM_TTL_MS - 1 })).toBe(false);
    expect(isBranchCreateClaimed(ISSUE, "feature/ak-670-b", { nowMs: T0 + CLAIM_TTL_MS - 1 })).toBe(true);
  });

  it("takes the claim over once it is older than the TTL, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(claimBranchForCreate(ISSUE, "feature/ak-670-a", { nowMs: T0 })).toBe(true);

    const later = T0 + CLAIM_TTL_MS + 1;
    expect(isBranchCreateClaimed(ISSUE, "feature/ak-670-a", { nowMs: later })).toBe(false);
    expect(claimBranchForCreate(ISSUE, "feature/ak-670-b", { nowMs: later })).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("abandoned worktree-create claim");

    // The takeover resets the clock — a third create is refused again, so an expiry does not
    // turn the directory into a free-for-all.
    expect(claimBranchForCreate(ISSUE, "feature/ak-670-c", { nowMs: later })).toBe(false);
  });

  it("honours an explicit ttlMs, so a caller can be stricter than the default", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(claimBranchForCreate(ISSUE, "feature/ak-670-a", { nowMs: T0, ttlMs: 1000 })).toBe(true);
    expect(claimBranchForCreate(ISSUE, "feature/ak-670-b", { nowMs: T0 + 999, ttlMs: 1000 })).toBe(false);
    expect(claimBranchForCreate(ISSUE, "feature/ak-670-b", { nowMs: T0 + 1001, ttlMs: 1000 })).toBe(true);
  });
});
