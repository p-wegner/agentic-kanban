import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, projectStatuses, issues, workspaces, sessions, agentSkills } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createInsightsRoute } from "../routes/insights.js";

/**
 * Integration tests for the Insights "By Skill" aggregation (#110).
 * Sessions must attribute to the skill recorded on the session at launch, fall
 * back to the workspace's skill for historical rows, and otherwise group under
 * "No Skill".
 */

interface SeedSessionOpts {
  /** Skill recorded on the SESSION row (per-session attribution). */
  sessionSkillId?: string | null;
  sessionSkillName?: string | null;
  /** Skill currently on the WORKSPACE (used as a fallback for historical rows). */
  wsSkillId?: string | null;
  startedAt?: string;
  stats?: Record<string, unknown>;
}

async function seed(db: TestDb, projectId: string, opts: SeedSessionOpts) {
  const now = new Date().toISOString();
  const startedAt = opts.startedAt ?? now;
  const issueId = randomUUID();
  const statusId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();

  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: Math.floor(Math.random() * 1e9), title: "T", priority: "medium",
    sortOrder: 0, statusId, projectId, issueType: "feature", createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak", workingDir: "/tmp/repo/.worktrees/ak",
    baseBranch: "main", isDirect: false, status: "active",
    skillId: opts.wsSkillId ?? null, createdAt: now, updatedAt: now,
  });
  await db.insert(sessions).values({
    id: sessionId, workspaceId, executor: "claude-code", status: "completed",
    startedAt, endedAt: now, exitCode: "0",
    stats: opts.stats ? JSON.stringify(opts.stats) : null,
    skillId: opts.sessionSkillId ?? null, skillName: opts.sessionSkillName ?? null,
  });
  return sessionId;
}

async function getBySkill(db: TestDb, projectId: string) {
  const app = createInsightsRoute(db);
  const res = await app.request(`/?projectId=${projectId}&range=all`);
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.bySkill as Array<{ skillId: string | null; skillName: string; sessionCount: number }>;
}

describe("insights by-skill attribution (#110)", () => {
  let db: TestDb;
  let projectId: string;

  beforeEach(async () => {
    ({ db } = createTestDb());
    projectId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(projects).values({
      id: projectId, name: "P", repoPath: "/tmp/repo", repoName: "repo",
      defaultBranch: "main", createdAt: now, updatedAt: now,
    });
  });

  it("attributes a session to the skill recorded on the session row", async () => {
    const skillId = randomUUID();
    await db.insert(agentSkills).values({
      id: skillId, name: "code-review", description: "d", prompt: "p",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    // Session carries its own skill; workspace skill is null (e.g. changed since launch).
    await seed(db, projectId, { sessionSkillId: skillId, sessionSkillName: "code-review", wsSkillId: null });

    const bySkill = await getBySkill(db, projectId);
    const bucket = bySkill.find((b) => b.skillId === skillId);
    expect(bucket).toBeDefined();
    expect(bucket!.skillName).toBe("code-review");
    expect(bucket!.sessionCount).toBe(1);
    expect(bySkill.find((b) => b.skillName === "No Skill")).toBeUndefined();
  });

  it("falls back to the workspace skill for historical sessions with no session skill", async () => {
    const skillId = randomUUID();
    await db.insert(agentSkills).values({
      id: skillId, name: "ticket-enhancer", description: "d", prompt: "p",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    // Historical row: session skill columns null, but workspace still has the skill.
    await seed(db, projectId, { sessionSkillId: null, sessionSkillName: null, wsSkillId: skillId });

    const bySkill = await getBySkill(db, projectId);
    const bucket = bySkill.find((b) => b.skillId === skillId);
    expect(bucket).toBeDefined();
    expect(bucket!.skillName).toBe("ticket-enhancer");
    expect(bucket!.sessionCount).toBe(1);
  });

  it("groups sessions launched without any skill under 'No Skill'", async () => {
    await seed(db, projectId, { sessionSkillId: null, sessionSkillName: null, wsSkillId: null });

    const bySkill = await getBySkill(db, projectId);
    const noSkill = bySkill.find((b) => b.skillName === "No Skill");
    expect(noSkill).toBeDefined();
    expect(noSkill!.skillId).toBeNull();
    expect(noSkill!.sessionCount).toBe(1);
  });

  it("returns ISO dates even when historical session timestamps are localized", async () => {
    await seed(db, projectId, {
      sessionSkillId: null,
      sessionSkillName: null,
      wsSkillId: null,
      startedAt: "1. Mai",
      stats: {
        durationMs: 1000,
        totalCostUsd: 0.01,
        inputTokens: 10,
        outputTokens: 5,
        numTurns: 1,
        model: "test-model",
        success: true,
      },
    });

    const app = createInsightsRoute(db);
    const res = await app.request(`/?projectId=${projectId}&range=all`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.totals.dateFrom).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.totals.dateTo).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.topExpensive[0].startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
