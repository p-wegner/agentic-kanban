// @covers workspaces.create.branch-create-claim [error]
//
// #719, the two properties the create-path integration test cannot show cheaply:
//  - the claim key is the WORKTREE PATH (every branch of issue N is one key), not the branch;
//  - a claim EXPIRES, so a create that hangs in `setupWorktree` cannot wedge
//    `409 BRANCH_CREATE_IN_FLIGHT` for the lifetime of the server process — which is what
//    #673's release-only-in-`finally` did.
// Pure unit test: the claim registry has no DB and no git, and the TTL is exercised through
// the injected `nowMs` rather than by waiting.
//
// #736 adds the two properties that needed the call site to change:
//  - the key is the FULL resolved path, so it is repo-scoped rather than issue-scoped — a
//    branch naming ANOTHER issue's number contends with that issue's directory;
//  - release takes a TOKEN, so a create whose claim was taken over on expiry can no longer
//    release its SUCCESSOR's claim.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CLAIM_TTL_MS,
  claimBranchForCreate,
  isBranchCreateClaimed,
  releaseBranchForCreate,
  resetBranchCreateClaims,
  worktreeClaimPath,
} from "../services/workspace-branch-create-claim.js";

const REPO = "/tmp/repo";
const OTHER_REPO = "/tmp/other-repo";
const ISSUE = "issue-uuid-1";
const OTHER_ISSUE = "issue-uuid-2";
const T0 = 1_700_000_000_000;

/** A claim target for this repo — the shape the create path passes. */
function target(branch: string, issueId = ISSUE, repoPath = REPO) {
  return { repoPath, issueId, branch };
}

describe("worktree-create claim is keyed on the path, not the branch (#719)", () => {
  beforeEach(() => resetBranchCreateClaims());
  afterEach(() => {
    resetBranchCreateClaims();
    vi.restoreAllMocks();
  });

  it("refuses a second branch of the same issue — both resolve to the leaf ak-670", () => {
    expect(claimBranchForCreate(target("feature/ak-670-monitor"), { nowMs: T0 })).not.toBeNull();
    expect(claimBranchForCreate(target("feature/ak-670-manual"), { nowMs: T0 })).toBeNull();
    // …and the same branch, which is the #673 case, is still refused.
    expect(claimBranchForCreate(target("feature/ak-670-monitor"), { nowMs: T0 })).toBeNull();
  });

  it("releasing any branch of the issue frees the directory it was holding", () => {
    const token = claimBranchForCreate(target("feature/ak-670-monitor"), { nowMs: T0 });
    expect(token).not.toBeNull();
    // Release names the CLAIM the caller took; the resource it frees is the directory.
    releaseBranchForCreate(token);
    expect(claimBranchForCreate(target("feature/ak-670-manual"), { nowMs: T0 })).not.toBeNull();
  });

  it("allows branches of one issue that resolve to DIFFERENT directories", () => {
    // No `ak-<n>` in the branch, so it keeps its own sanitized leaf instead of collapsing.
    expect(claimBranchForCreate(target("feature/ak-670-monitor"), { nowMs: T0 })).not.toBeNull();
    expect(claimBranchForCreate(target("showdown/codex"), { nowMs: T0 })).not.toBeNull();
  });

  it("does not let one issue's claim block another issue's own directory", () => {
    expect(claimBranchForCreate(target("feature/ak-670-monitor"), { nowMs: T0 })).not.toBeNull();
    expect(claimBranchForCreate(target("feature/ak-671-x", OTHER_ISSUE), { nowMs: T0 })).not.toBeNull();
  });
});

// #736 gap 1: #719 keyed on `issueId + leaf`, so two DIFFERENT issues could hold the same
// directory as long as their `issueId` halves differed — which happens whenever an explicit
// branch carries another issue's number. The key is now the resolved path, so `issueId` no
// longer partitions it.
describe("worktree-create claim is keyed on the FULL path, so it is repo-scoped (#736)", () => {
  beforeEach(() => resetBranchCreateClaims());
  afterEach(() => {
    resetBranchCreateClaims();
    vi.restoreAllMocks();
  });

  it("refuses another issue's create whose explicit branch names THIS issue's number", () => {
    // The premise, asserted rather than assumed: the two branches really do resolve to one
    // directory, so this test cannot quietly stop being about a collision.
    expect(worktreeClaimPath(REPO, "feature/ak-670-monitor"))
      .toBe(worktreeClaimPath(REPO, "feature/ak-670-named-by-another-issue"));

    expect(claimBranchForCreate(target("feature/ak-670-monitor"), { nowMs: T0 })).not.toBeNull();
    // Another issue's create, on a branch that resolves to issue 670's directory. Under
    // #719's `issueId + leaf` key this was granted and the two creates raced on one worktree.
    expect(
      claimBranchForCreate(target("feature/ak-670-named-by-another-issue", OTHER_ISSUE), { nowMs: T0 }),
    ).toBeNull();
  });

  it("keeps the SAME leaf in two different repos independent", () => {
    expect(worktreeClaimPath(REPO, "feature/ak-670-a"))
      .not.toBe(worktreeClaimPath(OTHER_REPO, "feature/ak-670-a"));
    expect(claimBranchForCreate(target("feature/ak-670-a"), { nowMs: T0 })).not.toBeNull();
    expect(
      claimBranchForCreate(target("feature/ak-670-a", OTHER_ISSUE, OTHER_REPO), { nowMs: T0 }),
    ).not.toBeNull();
  });

  it("reports the directory it claimed, so a 409 can name the resource", () => {
    const token = claimBranchForCreate(target("feature/ak-670-a"), { nowMs: T0 });
    expect(token?.worktreePath).toBe(worktreeClaimPath(REPO, "feature/ak-670-a"));
    expect(token?.worktreePath).toContain("ak-670");
  });
});

describe("worktree-create claim expires so a hung create cannot wedge it (#719)", () => {
  beforeEach(() => resetBranchCreateClaims());
  afterEach(() => {
    resetBranchCreateClaims();
    vi.restoreAllMocks();
  });

  it("still refuses a second create while the claim is inside its TTL", () => {
    expect(claimBranchForCreate(target("feature/ak-670-a"), { nowMs: T0 })).not.toBeNull();
    expect(claimBranchForCreate(target("feature/ak-670-b"), { nowMs: T0 + CLAIM_TTL_MS - 1 })).toBeNull();
    expect(isBranchCreateClaimed(target("feature/ak-670-b"), { nowMs: T0 + CLAIM_TTL_MS - 1 })).toBe(true);
  });

  it("takes the claim over once it is older than the TTL, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(claimBranchForCreate(target("feature/ak-670-a"), { nowMs: T0 })).not.toBeNull();

    const later = T0 + CLAIM_TTL_MS + 1;
    expect(isBranchCreateClaimed(target("feature/ak-670-a"), { nowMs: later })).toBe(false);
    expect(claimBranchForCreate(target("feature/ak-670-b"), { nowMs: later })).not.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("abandoned worktree-create claim");

    // The takeover resets the clock — a third create is refused again, so an expiry does not
    // turn the directory into a free-for-all.
    expect(claimBranchForCreate(target("feature/ak-670-c"), { nowMs: later })).toBeNull();
  });

  it("honours an explicit ttlMs, so a caller can be stricter than the default", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(claimBranchForCreate(target("feature/ak-670-a"), { nowMs: T0, ttlMs: 1000 })).not.toBeNull();
    expect(claimBranchForCreate(target("feature/ak-670-b"), { nowMs: T0 + 999, ttlMs: 1000 })).toBeNull();
    expect(claimBranchForCreate(target("feature/ak-670-b"), { nowMs: T0 + 1001, ttlMs: 1000 })).not.toBeNull();
  });
});

// #736 gap 2: the TTL means a claim can change hands, so "release the claim on this path" and
// "release MY claim" are different requests. #719 could only express the first.
describe("a taken-over create cannot release its successor's claim (#736)", () => {
  beforeEach(() => resetBranchCreateClaims());
  afterEach(() => {
    resetBranchCreateClaims();
    vi.restoreAllMocks();
  });

  it("no-ops when the claim on that path now belongs to a later create", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const hung = claimBranchForCreate(target("feature/ak-670-a"), { nowMs: T0 });
    const later = T0 + CLAIM_TTL_MS + 1;
    const successor = claimBranchForCreate(target("feature/ak-670-b"), { nowMs: later });
    expect(successor).not.toBeNull();
    // Same directory, so the two tokens name the same key — only the holder differs.
    expect(successor!.worktreePath).toBe(hung!.worktreePath);

    // The hung create finally reaches its `finally` and releases. Under #719 this deleted the
    // successor's claim, leaving the successor provisioning an UNGUARDED directory.
    releaseBranchForCreate(hung);
    expect(isBranchCreateClaimed(target("feature/ak-670-b"), { nowMs: later + 1 })).toBe(true);
    expect(claimBranchForCreate(target("feature/ak-670-c"), { nowMs: later + 1 })).toBeNull();

    // The successor's own release still works.
    releaseBranchForCreate(successor);
    expect(isBranchCreateClaimed(target("feature/ak-670-c"), { nowMs: later + 1 })).toBe(false);
  });

  it("tolerates a release with no claim (never claimed, or already released)", () => {
    const token = claimBranchForCreate(target("feature/ak-670-a"), { nowMs: T0 });
    releaseBranchForCreate(token);
    expect(() => releaseBranchForCreate(token)).not.toThrow();
    expect(() => releaseBranchForCreate(null)).not.toThrow();
    expect(claimBranchForCreate(target("feature/ak-670-a"), { nowMs: T0 })).not.toBeNull();
  });
});
