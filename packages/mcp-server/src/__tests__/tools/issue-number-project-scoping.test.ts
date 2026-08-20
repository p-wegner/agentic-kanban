// @covers mcp.get-issue.project-scoping [correctness,multi-project]
//
// Regression for #506. `get_issue` (numeric ref, no projectId) and `get_issue_summary`
// resolved an issue NUMBER with a bare `where(issueNumber = N).limit(1)` and no project
// filter. Issue numbers are per-project (`MAX(issue_number) + 1`), so that matches a row in
// every project that has reached N and returns an arbitrary one.
//
// It was verified live before the fix: on a 25-project board, `GET /api/issues/5/summary`
// returned a fixture project's issue, not the active project's.
//
// This is invisible on a single-project board, which is why it survived — so every test
// here seeds TWO projects that both own the same issue number.
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { registerGetIssue } from "../../tools/get-issue.js";
import { registerGetIssueSummary } from "../../tools/get-issue-summary.js";
import { setupTool } from "../helpers/tool-harness.js";
import { seedProject, seedIssue, setActiveProject } from "../helpers/seed.js";
import type { TestDb } from "../helpers/test-db.js";

/** Two projects, each owning an issue numbered `n`. Returns both issue ids. */
async function seedTwoProjectsSharingNumber(db: TestDb, n: number) {
  const a = await seedProject(db, "Project A");
  const b = await seedProject(db, "Project B");
  // Same issue NUMBER in both projects — the whole point. Numbers are per-project, so this
  // is an ordinary board state, not a contrived one.
  const issueA = await seedIssue(db, a.projectId, a.statusIds["Todo"], { title: "PROJECT A ticket", issueNumber: n });
  const issueB = await seedIssue(db, b.projectId, b.statusIds["Todo"], { title: "PROJECT B ticket", issueNumber: n });
  return { a, b, issueA, issueB };
}

describe("get_issue resolves a numeric ref within one project (#506)", () => {
  it("returns the ACTIVE project's issue when no projectId is given", async () => {
    const { invoke, db } = setupTool(registerGetIssue);
    const { b, issueB } = await seedTwoProjectsSharingNumber(db, 7);
    await setActiveProject(db, b.projectId);

    const parsed = JSON.parse((await invoke({ issueId: "7" })).content[0].text);
    expect(parsed.id).toBe(issueB.id);
    expect(parsed.title).toBe("PROJECT B ticket");
  });

  it("an explicit projectId still wins over the active project", async () => {
    const { invoke, db } = setupTool(registerGetIssue);
    const { a, b, issueA } = await seedTwoProjectsSharingNumber(db, 7);
    await setActiveProject(db, b.projectId);

    const parsed = JSON.parse((await invoke({ issueId: "7", projectId: a.projectId })).content[0].text);
    expect(parsed.id).toBe(issueA.id);
    expect(parsed.title).toBe("PROJECT A ticket");
  });

  it("a UUID ref is unaffected by project scoping", async () => {
    const { invoke, db } = setupTool(registerGetIssue);
    const { b, issueA } = await seedTwoProjectsSharingNumber(db, 7);
    await setActiveProject(db, b.projectId); // deliberately the OTHER project

    const parsed = JSON.parse((await invoke({ issueId: issueA.id })).content[0].text);
    expect(parsed.id).toBe(issueA.id);
  });
});

describe("get_issue_summary resolves a numeric ref within one project (#506)", () => {
  it("does not reach into another project's issue with the same number", async () => {
    const { invoke, db } = setupTool(registerGetIssueSummary);
    const { b } = await seedTwoProjectsSharingNumber(db, 7);
    await setActiveProject(db, b.projectId);

    // Neither issue has a workspace, so the interesting part is WHICH issue it resolved.
    const parsed = JSON.parse((await invoke({ issueNumber: 7 })).content[0].text);
    // Positive assertion, so the test cannot pass just because the tool errored: it must
    // have resolved project B's issue #7 specifically.
    expect(parsed.title).toBe("PROJECT B ticket");
    expect(JSON.stringify(parsed)).not.toContain("PROJECT A ticket");
  });
});

/**
 * The second half of #506: which session represents the issue. The CLI has always
 * skipped analytics noise (`selectSummarySession`), while this tool took
 * `find(completed|stopped) ?? rows[0]` and would report a board-monitor pass as the
 * agent's work on the ticket. Both now go through the shared `loadIssueSummary`.
 */
describe("get_issue_summary skips analytics-noise sessions (#506)", () => {
  /** One workspace with two completed sessions: a noise one, and the real agent run. */
  async function seedNoiseAndRealSession(db: TestDb, issueId: string) {
    const workspaceId = randomUUID();
    await db.insert(schema.workspaces).values({
      id: workspaceId, issueId, branch: "feature/ak-7", status: "idle",
      workingDir: "/tmp/ws", createdAt: new Date().toISOString(),
    });
    const insert = async (triggerType: string, agentSummary: string, startedAt: string) => {
      await db.insert(schema.sessions).values({
        id: randomUUID(), workspaceId, status: "completed", startedAt, triggerType,
        stats: JSON.stringify({ agentSummary }),
      });
    };
    // The noise session is the MOST RECENT, so an unfiltered `rows[0]` picks it.
    await insert("agent", "REAL agent work", "2026-01-01T10:00:00.000Z");
    await insert("skill:board-monitor", "MONITOR sweep", "2026-01-01T12:00:00.000Z");
  }

  it("summarizes the agent run, not the more recent board-monitor session", async () => {
    const { invoke, db } = setupTool(registerGetIssueSummary);
    const { b, issueB } = await seedTwoProjectsSharingNumber(db, 7);
    await setActiveProject(db, b.projectId);
    await seedNoiseAndRealSession(db, issueB.id);

    const parsed = JSON.parse((await invoke({ issueNumber: 7 })).content[0].text);
    expect(parsed.agentSummary).toBe("REAL agent work");
  });

  it("falls back to a noise session when it is the ONLY one", async () => {
    const { invoke, db } = setupTool(registerGetIssueSummary);
    const { b, issueB } = await seedTwoProjectsSharingNumber(db, 7);
    await setActiveProject(db, b.projectId);
    const workspaceId = randomUUID();
    await db.insert(schema.workspaces).values({
      id: workspaceId, issueId: issueB.id, branch: "feature/ak-7", status: "idle",
      workingDir: "/tmp/ws", createdAt: new Date().toISOString(),
    });
    await db.insert(schema.sessions).values({
      id: randomUUID(), workspaceId, status: "completed",
      startedAt: "2026-01-01T10:00:00.000Z",
      stats: JSON.stringify({ agentSummary: "MONITOR sweep" }),
      triggerType: "skill:board-monitor",
    });

    // Reporting "no session" here would be a regression: the issue DOES have one.
    const parsed = JSON.parse((await invoke({ issueNumber: 7 })).content[0].text);
    expect(parsed.status).toBeUndefined();
    expect(parsed.agentSummary).toBe("MONITOR sweep");
  });
});
