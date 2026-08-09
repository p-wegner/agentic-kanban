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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

/**
 * Round 8. The first fix put the claim in `dependency-auto-chain` and `dependency-wave` — neither of
 * which is on the path the pm-pipeline loop actually uses. The registry ended up with three WRITERS
 * and one READER, and the reader was on neither producing path, so the duplicates continued on a
 * server carrying the fix: kassenbuch #9 got two workspaces sharing ONE worktree and branch (two
 * `claude.exe` step agents writing the same files for ~5 minutes), and linklocker #3 got three rows,
 * leaving two divergent commits stranded on an unmerged branch.
 *
 * These are source-level assertions on purpose. The defect was never a wrong function — it was a
 * call site that failed to consult the guard, which no unit test of the guard itself can catch.
 */
describe("#366 round 8: every automatic starter goes through the claim", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const monitorSrc = read("../startup/monitor-auto-start.ts");
  const routeSrc = read("../routes/workspaces.ts");
  const loopStartSrc = read("../services/plugin-loop-start.service.ts");

  it("the monitor's auto-start launches declare themselves as auto-starters", () => {
    const launches = monitorSrc.match(/\/api\/workspaces\?[^`"']*/g) ?? [];
    // Both loops (the In-Progress backfill and the Todo pull) launch, and both must claim.
    expect(launches.length).toBeGreaterThanOrEqual(2);
    for (const url of launches) expect(url).toContain("autoStart=1");
  });

  it("the async create route claims for an auto-starter instead of blindly registering", () => {
    expect(routeSrc).toContain("claimIssueForAutoStart");
    // A refused claim must be an explicit 409, not a silently duplicated launch.
    expect(routeSrc).toContain("create_in_flight");
  });

  it("the monitor treats a refused claim as a skip, not as a failed launch", () => {
    // Counting it as a failure would burn a WIP slot and log an auto_start failure for a launch
    // that is in fact proceeding under the other starter.
    expect(monitorSrc).toContain(`"create_in_flight"`);
  });

  it("the plugin-loop advance path claims rather than only writing the registry", () => {
    expect(loopStartSrc).toContain("claimIssueForAutoStart");
    // The old call is what made it a write-only producer.
    expect(loopStartSrc).not.toMatch(/\bstartCreateJob\(/);
  });

  it("no starter recomputes a branch slug of its own any more", () => {
    // The surviving third producer lived in the Todo-pull loop: `[^a-z0-9\s] -> ""` then
    // `\s+ -> "-"`, which is exactly the `89-cicd` form observed on the duplicate rows.
    // Matched as a `.replace(...)` call so the explanatory comments above (which quote the old
    // character class verbatim) don't trip it.
    expect(monitorSrc).not.toMatch(/\.replace\(\/\[\^a-z0-9/);
    expect(monitorSrc).toContain("suggestBranchName(");
  });
});
