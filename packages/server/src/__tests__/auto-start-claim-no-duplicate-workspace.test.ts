/**
 * Regression test for issue #366.
 *
 * One pipeline unit got TWO workspaces, two worktrees and two differently-slugified branches
 * for the same `issueId`, 2m34s apart, reproduced 2 of 2 on pm-pipeline gate approvals. The
 * duplicate was not inert: it ran a full agent and committed a DIVERGENT artifact (97 lines
 * against the 135 that merged) stranded on an unmerged branch.
 *
 * Two independent defects made it possible:
 *  1. Every automatic starter asked the `workspaces` TABLE whether the issue already had a
 *     workspace. The row is inserted only at the END of provisioning (80s to 8+ minutes), so
 *     for that whole window the check reads "no workspace" for an issue that is actively being
 *     provisioned by another starter.
 *  2. Two different branch-name producers — `suggestBranchName` (separators) and a private
 *     `slugifyTitle` (strip) — so the same issue got a different branch depending on which
 *     starter ran, and no branch-collision check could ever match across paths.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { suggestBranchName } from "@agentic-kanban/shared/lib/branch";
import { claimIssueForAutoStart, isAutoStartClaimed } from "../services/auto-start-claim.js";
import { completeCreateJob, failCreateJob, resetCreateJobs } from "../services/create-job.service.js";

describe("auto-start claim: two starters cannot both provision one issue (#366)", () => {
  beforeEach(() => resetCreateJobs());

  it("grants the first claim and refuses the second while it is in flight", () => {
    const issueId = "issue-366-a";
    const first = claimIssueForAutoStart(issueId);
    expect(first).not.toBeNull();
    expect(isAutoStartClaimed(issueId)).toBe(true);
    // This is the cascade arriving 2m34s later, mid-provisioning, in the window where the
    // workspaces table still holds no row for the issue.
    expect(claimIssueForAutoStart(issueId)).toBeNull();
  });

  it("does not block a DIFFERENT issue", () => {
    expect(claimIssueForAutoStart("issue-366-b")).not.toBeNull();
    expect(claimIssueForAutoStart("issue-366-c")).not.toBeNull();
  });

  it("releases the claim once provisioning succeeds, so a later legitimate start is allowed", () => {
    const issueId = "issue-366-d";
    const claim = claimIssueForAutoStart(issueId);
    completeCreateJob(claim!.jobId, { id: "ws-1", status: "active" });
    expect(isAutoStartClaimed(issueId)).toBe(false);
    expect(claimIssueForAutoStart(issueId)).not.toBeNull();
  });

  it("releases the claim when provisioning FAILS — a failed start must not wedge the issue", () => {
    const issueId = "issue-366-e";
    const claim = claimIssueForAutoStart(issueId);
    failCreateJob(claim!.jobId, new Error("worktree add failed"));
    expect(isAutoStartClaimed(issueId)).toBe(false);
    expect(claimIssueForAutoStart(issueId)).not.toBeNull();
  });

  it("releases the claim when createWorkspace resolves with an error status (it rarely throws)", () => {
    const issueId = "issue-366-f";
    const claim = claimIssueForAutoStart(issueId);
    completeCreateJob(claim!.jobId, { status: "error", error: "no default branch" });
    expect(isAutoStartClaimed(issueId)).toBe(false);
  });
});

describe("branch naming has ONE producer (#366)", () => {
  // The exact titles from the two reproduced instances. Each pair is what the two producers
  // used to emit; only the first form may be produced now.
  it("emits the separator form for the kassenbuch step-8 title, not the stripped form", () => {
    const branch = suggestBranchName({ issueNumber: 8, title: "PM pipeline 8/9: CI/CD & Deployment" });
    expect(branch).toBe("feature/ak-8-pm-pipeline-8-9-ci-cd-deployment");
    expect(branch).not.toBe("feature/ak-8-pm-pipeline-89-cicd-deployment");
  });

  it("emits the separator form for the habitloop step-3 title, not the stripped form", () => {
    const branch = suggestBranchName({ issueNumber: 3, title: "PM pipeline 3/9: Roadmap & Epics" });
    expect(branch).toBe("feature/ak-3-pm-pipeline-3-9-roadmap-epics");
    expect(branch).not.toBe("feature/ak-3-pm-pipeline-39-roadmap-epics");
  });
});
