/**
 * #1597 — the CI watch must not re-file a heal ticket for a red run an already-CLOSED heal ticket
 * was filed against (the fix landed locally; origin still shows the same red run until a push).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projects } from "@agentic-kanban/shared/schema";
import { ciHealBody, ciHealExternalKey, formatCiRedUnpushed, summarizeWorkflows, toCiSnapshot, type GhRun } from "../lib/ci-status.js";
import { createTestDb } from "./helpers/test-db.js";
import { initializeProjectStatuses } from "../repositories/issue.repository.js";
import { reconcileCiHealTickets } from "../services/ci-status.service.js";

const run = (n: number, sha: string): GhRun => ({
  databaseId: n,
  workflowName: "arch-gate",
  status: "completed",
  conclusion: "failure",
  headSha: sha,
  url: `https://github.com/o/r/actions/runs/${n}`,
  createdAt: new Date(Date.now() - (10 - n) * 86_400_000).toISOString(),
  event: "push",
});

describe("CI heal ticket vs a closed ticket for the same run (#1597)", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let projectId: string;
  let statusIds: Record<string, string>;
  let created: number;
  const gh = async () => ({ stdout: "{}", stderr: "", code: 0, error: null });
  const createIssue = async () => {
    created++;
    return { id: randomUUID(), issueNumber: 900 + created } as never;
  };

  beforeEach(async () => {
    ({ db } = createTestDb());
    projectId = randomUUID();
    created = 0;
    await db.insert(projects).values({ id: projectId, name: "ci", repoPath: "C:/repo", repoName: "repo", createdAt: new Date().toISOString() });
    statusIds = await initializeProjectStatuses(projectId, new Date().toISOString(), db);
  });

  async function poll(states: ReturnType<typeof summarizeWorkflows>) {
    return reconcileCiHealTickets({ projectId, branch: "master", states, repoPath: "C:/repo", gh, createIssue, now: new Date().toISOString() }, db);
  }

  async function insertHeal(state: ReturnType<typeof summarizeWorkflows>[number], statusId: string) {
    const now = new Date().toISOString();
    await db.insert(issues).values({
      id: randomUUID(), issueNumber: 50, title: "heal", description: ciHealBody("master", state, []),
      priority: "critical", issueType: "task", skipAutoReview: false, estimate: null, sortOrder: 0,
      statusId, projectId, externalKey: ciHealExternalKey(projectId, "arch-gate"), createdAt: now, updatedAt: now,
    });
  }

  it("files nothing when a closed heal ticket was filed against the same run and sha", async () => {
    const states = summarizeWorkflows([run(9, "c156b32"), run(8, "c156b32")]);
    await insertHeal(states[0], statusIds.Done);
    expect(await poll(states)).toEqual([]);
    expect(created).toBe(0);
  });

  it("still files for a NEW red run (different sha) after a closed ticket", async () => {
    await insertHeal(summarizeWorkflows([run(9, "c156b32"), run(8, "c156b32")])[0], statusIds.Done);
    const fresh = summarizeWorkflows([run(11, "ffff111"), run(10, "ffff111")]);
    expect((await poll(fresh)).map((t) => t.action)).toEqual(["created"]);
  });

  it("an unseen red still files when no ticket exists", async () => {
    expect((await poll(summarizeWorkflows([run(9, "c156b32"), run(8, "c156b32")]))).map((t) => t.action)).toEqual(["created"]);
  });

  it("the console line names unpushed commits", () => {
    const states = summarizeWorkflows([run(9, "c156b32"), run(8, "c156b32")]);
    const snap = toCiSnapshot("master", states, new Date().toISOString(), new Map([["arch-gate", 130]]));
    expect(snap.red[0].text).toBe(formatCiRedUnpushed(states[0], 130));
    expect(snap.red[0].text).toContain("130 commits not pushed; the fix may already be local");
    expect(toCiSnapshot("master", states, "x").red[0].text).not.toContain("not pushed");
  });
});
