import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  computeReviewEffectiveness,
  resolveDriveIssueIds,
  classifyTrigger,
} from "../services/review-effectiveness.service.js";

const { db } = createTestDb();

let projectId: string;
let statusId: string;
let metaIssueId: string;
let childAId: string;
let childBId: string;
let unrelatedIssueId: string;

/** A fixed clock so seeded timestamps don't age out of test windows. */
const T0 = new Date("2026-01-01T00:00:00.000Z").getTime();
const at = (offsetMin: number) => new Date(T0 + offsetMin * 60_000).toISOString();

async function makeIssue(title: string, num: number): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.issues).values({
    id,
    issueNumber: num,
    title,
    statusId,
    projectId,
    createdAt: at(0),
    updatedAt: at(0),
  });
  return id;
}

async function makeWorkspace(
  issueId: string,
  opts: { merged?: boolean; mergedAt?: string; scorecard?: number | null; status?: string; provider?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.workspaces).values({
    id,
    issueId,
    branch: `feature/${issueId.slice(0, 6)}`,
    status: opts.status ?? "idle",
    provider: opts.provider ?? "claude",
    readyForMerge: !!opts.merged,
    mergedAt: opts.merged ? (opts.mergedAt ?? at(60)) : null,
    scorecardScore: opts.scorecard ?? null,
    createdAt: at(0),
    updatedAt: at(0),
  });
  return id;
}

async function makeSession(
  workspaceId: string,
  triggerType: string | null,
  startedAt: string,
  opts: { costUsd?: number; executor?: string } = {},
): Promise<void> {
  await db.insert(schema.sessions).values({
    id: randomUUID(),
    workspaceId,
    executor: opts.executor ?? "claude-code",
    status: "stopped",
    startedAt,
    endedAt: startedAt,
    triggerType,
    stats: opts.costUsd != null ? JSON.stringify({ totalCostUsd: opts.costUsd, numTurns: 1, durationMs: 1000 }) : null,
  });
}

async function link(issueId: string, dependsOnId: string, type: schema.DependencyType): Promise<void> {
  await db.insert(schema.issueDependencies).values({
    id: randomUUID(),
    issueId,
    dependsOnId,
    type,
    createdAt: at(0),
  });
}

describe("classifyTrigger", () => {
  it("identifies review, build, rework, noise and legacy-null triggers", () => {
    expect(classifyTrigger("review")).toBe("review");
    expect(classifyTrigger("skill:code-review-thorough")).toBe("review");
    expect(classifyTrigger("agent")).toBe("build");
    expect(classifyTrigger(null)).toBe("build");
    expect(classifyTrigger("fix-and-merge")).toBe("rework");
    expect(classifyTrigger("skill:board-monitor")).toBe("noise");
    expect(classifyTrigger("verify")).toBe("other");
  });
});

describe("resolveDriveIssueIds", () => {
  beforeAll(async () => {
    projectId = randomUUID();
    await db.insert(schema.projects).values({
      id: projectId, name: "RE Project", repoPath: "/tmp/re-repo", repoName: "re-repo",
      defaultBranch: "main", createdAt: at(0), updatedAt: at(0),
    });
    statusId = randomUUID();
    await db.insert(schema.projectStatuses).values({
      id: statusId, projectId, name: "In Progress", sortOrder: 1, isDefault: true,
    });

    metaIssueId = await makeIssue("Epic: drive the thing", 1);
    childAId = await makeIssue("Child A", 2);
    childBId = await makeIssue("Child B", 3);
    unrelatedIssueId = await makeIssue("Unrelated", 4);

    // Epic --parent_of--> A, A --depends_on--> B (B reachable transitively).
    await link(metaIssueId, childAId, "parent_of");
    await link(childAId, childBId, "depends_on");
  });

  it("returns the meta-issue plus its dependency subtree", async () => {
    const ids = await resolveDriveIssueIds(metaIssueId, projectId, db);
    expect(ids).not.toBeNull();
    const set = new Set(ids!);
    expect(set.has(metaIssueId)).toBe(true);
    expect(set.has(childAId)).toBe(true);
    expect(set.has(childBId)).toBe(true);
    expect(set.has(unrelatedIssueId)).toBe(false);
  });

  it("returns null when the drive has no meta-issue", async () => {
    expect(await resolveDriveIssueIds(null, projectId, db)).toBeNull();
  });
});

describe("computeReviewEffectiveness", () => {
  let p2: string;
  let s2: string;
  let metaA: string;
  let childAttempt: string;
  let unreviewedMerged: string;
  let outOfWindow: string;

  beforeAll(async () => {
    p2 = randomUUID();
    await db.insert(schema.projects).values({
      id: p2, name: "RE Project 2", repoPath: "/tmp/re-repo2", repoName: "re-repo2",
      defaultBranch: "main", createdAt: at(0), updatedAt: at(0),
    });
    s2 = randomUUID();
    await db.insert(schema.projectStatuses).values({
      id: s2, projectId: p2, name: "In Progress", sortOrder: 1, isDefault: true,
    });

    const mkIssue = async (title: string, num: number) => {
      const id = randomUUID();
      await db.insert(schema.issues).values({
        id, issueNumber: num, title, statusId: s2, projectId: p2, createdAt: at(0), updatedAt: at(0),
      });
      return id;
    };

    metaA = await mkIssue("Epic 2", 10);
    childAttempt = await mkIssue("Child reviewed+bounced", 11);
    unreviewedMerged = await mkIssue("Merged without review", 12);
    outOfWindow = await mkIssue("Out of window", 13);
    await link(metaA, childAttempt, "parent_of");
    await link(metaA, unreviewedMerged, "parent_of");
    await link(metaA, outOfWindow, "parent_of");
  });

  it("reports coverage, bounce-backs, and merged-without-review within a window scoped to issues", async () => {
    // Child: build (at 10) -> review (at 20) -> build again (at 30) => review bounced it back; merged, scorecard 88.
    const wsChild = await makeWorkspace(childAttempt, { merged: true, mergedAt: at(40), scorecard: 88 });
    await makeSession(wsChild, "agent", at(10), { costUsd: 1.0 });
    await makeSession(wsChild, "review", at(20), { costUsd: 0.2, executor: "claude-code" });
    await makeSession(wsChild, "agent", at(30), { costUsd: 0.5 });

    // Unreviewed-merged: only a build session, then merged in-window — no review run.
    const wsUnrev = await makeWorkspace(unreviewedMerged, { merged: true, mergedAt: at(45) });
    await makeSession(wsUnrev, "agent", at(15), { costUsd: 0.3 });

    // Out-of-window build (long before the drive window starts) — must be excluded.
    const wsOut = await makeWorkspace(outOfWindow, {});
    await makeSession(wsOut, "agent", at(-10_000));

    const report = await computeReviewEffectiveness(
      {
        projectId: p2,
        sinceIso: at(0),
        untilIso: at(100),
        issueIds: [metaA, childAttempt, unreviewedMerged, outOfWindow],
      },
      db,
    );

    expect(report.totals.implementationAttempts).toBe(2); // child + unreviewed (out-of-window excluded)
    expect(report.reviewCoverage.attemptsReviewed).toBe(1); // only the child had a review
    expect(report.reviewImpact.reviewsThatBouncedBackToWork).toBe(1); // build after review
    expect(report.totals.mergedInWindow).toBe(2); // child + unreviewed merged within window
    const mergedWithoutReviewNums = report.reviewCoverage.mergedWithoutReview.map((m) => m.issue).sort();
    expect(mergedWithoutReviewNums).toEqual([12]);
    expect(report.scorecard.count).toBe(1);
    expect(report.scorecard.avg).toBe(88);
    expect(report.cost.reviewCostUsd).toBeCloseTo(0.2, 5);
  });

  it("excludes issues outside the issueId scope", async () => {
    const report = await computeReviewEffectiveness(
      { projectId: p2, sinceIso: at(0), untilIso: at(100), issueIds: [outOfWindow] },
      db,
    );
    // outOfWindow's only session is before the window — nothing in scope.
    expect(report.totals.sessionsInWindow).toBe(0);
    expect(report.totals.implementationAttempts).toBe(0);
  });

  it("an empty issueId scope yields an empty report (does not fall through to whole project)", async () => {
    const report = await computeReviewEffectiveness(
      { projectId: p2, sinceIso: at(0), untilIso: at(100), issueIds: [] },
      db,
    );
    expect(report.totals.sessionsInWindow).toBe(0);
    expect(report.totals.ticketAttemptsTouched).toBe(0);
  });
});
