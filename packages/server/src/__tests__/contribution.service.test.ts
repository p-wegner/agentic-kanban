import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import type { ContributionActorRow } from "@agentic-kanban/shared";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createContributionService } from "../services/contribution.service.js";
import { parseContributionQuery } from "../lib/contribution-query.js";
import type { GitService } from "../services/workspace-internals.js";

let db: TestDb;
let projectId: string;
let doneStatusId: string;
let todoStatusId: string;

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

// Keyed by the tip ref the service resolves against (`mergedHeadSha`).
const COMMITS: Record<string, { sha: string; author: string; added: number; removed: number }[]> = {
  tipA: [
    { sha: "a1", author: "Ada", added: 10, removed: 2 },
    { sha: "a2", author: "Bob", added: 5, removed: 1 },
  ],
  tipB: [{ sha: "b1", author: "Ada", added: 7, removed: 0 }],
};

const fakeGit = {
  async getCommitStatsForRange(_repo: string, _base: string, tip: string) {
    return COMMITS[tip] ?? [];
  },
} as unknown as GitService;

async function seedWorkspace(opts: {
  statusId: string;
  provider: string | null;
  profile: string | null;
  model: string | null;
  mergedDaysAgo?: number;
  mergedHeadSha?: string;
  sessions: { status: string; stats: unknown; daysAgo: number; durationMs?: number }[];
}) {
  const issueId = randomUUID();
  const created = iso(-20);
  await db.insert(schema.issues).values({
    id: issueId,
    issueNumber: Math.floor(Math.random() * 1e9),
    title: "t",
    statusId: opts.statusId,
    projectId,
    createdAt: created,
    updatedAt: iso(-1),
    statusChangedAt: iso(-(opts.mergedDaysAgo ?? 1)),
  });
  const wsId = randomUUID();
  await db.insert(schema.workspaces).values({
    id: wsId,
    issueId,
    branch: "feature/x",
    baseBranch: "master",
    baseCommitSha: "base",
    status: "closed",
    provider: opts.provider,
    claudeProfile: opts.profile,
    model: opts.model,
    mergedAt: opts.mergedDaysAgo === undefined ? null : iso(-opts.mergedDaysAgo),
    mergedHeadSha: opts.mergedHeadSha ?? null,
    createdAt: created,
    updatedAt: created,
  });
  for (const s of opts.sessions) {
    const startedAt = iso(-s.daysAgo);
    await db.insert(schema.sessions).values({
      id: randomUUID(),
      workspaceId: wsId,
      executor: "claude-code",
      status: s.status,
      startedAt,
      endedAt: s.durationMs ? new Date(Date.parse(startedAt) + s.durationMs).toISOString() : null,
      stats: s.stats === null ? null : typeof s.stats === "string" ? s.stats : JSON.stringify(s.stats),
    });
  }
}

beforeAll(async () => {
  db = createTestDb().db;
  const now = new Date().toISOString();
  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "P", repoPath: "/tmp/p", repoName: "p", defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  doneStatusId = randomUUID();
  todoStatusId = randomUUID();
  await db.insert(schema.projectStatuses).values([
    { id: doneStatusId, projectId, name: "Done", sortOrder: 4, isDefault: false, createdAt: now },
    { id: todoStatusId, projectId, name: "Todo", sortOrder: 1, isDefault: true, createdAt: now },
  ]);

  // claude / profile p1 / opus: one merged Done issue (tipA), 2 sessions (one failed), tokens + cost.
  await seedWorkspace({
    statusId: doneStatusId, provider: "claude", profile: "p1", model: "opus",
    mergedDaysAgo: 3, mergedHeadSha: "tipA",
    sessions: [
      { status: "completed", daysAgo: 4, durationMs: 60_000, stats: { inputTokens: 100, outputTokens: 50, totalCostUsd: 1.5, success: true } },
      { status: "completed", daysAgo: 3, durationMs: 30_000, stats: { inputTokens: 10, outputTokens: 5, totalCostUsd: 0.5, success: false } },
    ],
  });
  // codex / no profile / no model: one merged Done issue (tipB), one stopped session with NO stats.
  await seedWorkspace({
    statusId: doneStatusId, provider: "codex", profile: null, model: null,
    mergedDaysAgo: 15, mergedHeadSha: "tipB",
    sessions: [{ status: "stopped", daysAgo: 16, stats: null }],
  });
  // claude / p1 / opus again: unmerged Todo issue with a malformed stats blob.
  await seedWorkspace({
    statusId: todoStatusId, provider: "claude", profile: "p1", model: "opus",
    sessions: [{ status: "failed", daysAgo: 2, stats: "{not json" }],
  });
});

const service = () => createContributionService({ database: db, gitService: fakeGit });
const byActor = (actors: ContributionActorRow[], name: string) => actors.find((a) => a.actor === name)!;

describe("createContributionService", () => {
  it("returns null for an unknown project", async () => {
    expect(await service().getContributions(randomUUID(), "provider", {})).toBeNull();
  });

  it("groups by provider with counts, sessions, tokens, duration and git totals", async () => {
    const res = (await service().getContributions(projectId, "provider", {}))!;
    expect(res.actors.map((a) => a.actor)).toEqual(["claude", "codex"]);

    const claude = byActor(res.actors, "claude");
    expect(claude).toMatchObject({
      workspaces: 2, mergedIssues: 1, doneIssues: 1,
      sessions: 3, failedSessions: 2, abortedSessions: 0,
      inputTokens: 110, outputTokens: 55, costUsd: 2,
      mergedCommits: 2, linesAdded: 15, linesRemoved: 3,
    });
    // Derived from julianday() arithmetic, so compare with a tolerance.
    expect(claude.activeMs).toBeCloseTo(90_000, -1);

    const codex = byActor(res.actors, "codex");
    expect(codex).toMatchObject({
      workspaces: 1, mergedIssues: 1, doneIssues: 1, sessions: 1, abortedSessions: 1, failedSessions: 0,
      mergedCommits: 1, linesAdded: 7, linesRemoved: 0,
    });
    // No session recorded tokens/cost/duration for codex: null ("–"), never 0.
    expect(codex.inputTokens).toBeNull();
    expect(codex.costUsd).toBeNull();
    expect(codex.activeMs).toBeNull();
  });

  it("groups by profile, putting unset profiles in the placeholder bucket", async () => {
    const res = (await service().getContributions(projectId, "profile", {}))!;
    const unset = res.actors.find((a) => a.unset)!;
    expect(unset.actor).toBe("(default profile)");
    expect(unset.workspaces).toBe(1);
    expect(byActor(res.actors, "p1").workspaces).toBe(2);
  });

  it("groups by model", async () => {
    const res = (await service().getContributions(projectId, "model", {}))!;
    expect(byActor(res.actors, "opus")).toMatchObject({ workspaces: 2, mergedIssues: 1, sessions: 3 });
    expect(res.actors.find((a) => a.unset)!.actor).toBe("(default model)");
  });

  it("groups by git author from the merged commits only", async () => {
    const res = (await service().getContributions(projectId, "author", {}))!;
    expect(res.actors.map((a) => a.actor)).toEqual(["Ada", "Bob"]);
    expect(byActor(res.actors, "Ada")).toMatchObject({ mergedCommits: 2, linesAdded: 17, linesRemoved: 2, sessions: 0 });
    expect(byActor(res.actors, "Bob")).toMatchObject({ mergedCommits: 1, linesAdded: 5, linesRemoved: 1 });
  });

  it("applies the time window server-side", async () => {
    const res = (await service().getContributions(projectId, "provider", { from: iso(-10) }))!;
    // The codex workspace was created, merged and ran outside the window except for its
    // creation (20 days ago is also outside), so it has no row at all.
    expect(res.actors.map((a) => a.actor)).toEqual(["claude"]);
    const claude = res.actors[0];
    expect(claude.sessions).toBe(3);
    expect(claude.mergedCommits).toBe(2);
    expect(res.from).not.toBeNull();
    expect(res.to).toBeNull();

    const narrow = (await service().getContributions(projectId, "provider", { from: iso(-3.5), to: iso(-2.5) }))!;
    expect(byActor(narrow.actors, "claude")).toMatchObject({ sessions: 1, mergedIssues: 1 });
  });

  it("returns no actors for an empty project", async () => {
    const emptyId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.projects).values({
      id: emptyId, name: "E", repoPath: "/tmp/e", repoName: "e", defaultBranch: "master", createdAt: now, updatedAt: now,
    });
    const res = (await service().getContributions(emptyId, "provider", {}))!;
    expect(res.actors).toEqual([]);
  });
});

describe("parseContributionQuery", () => {
  it("defaults groupBy to provider", () => {
    expect(parseContributionQuery({})).toEqual({ ok: true, groupBy: "provider", window: { from: undefined, to: undefined } });
  });
  it("rejects an unknown groupBy, bad dates and an inverted range", () => {
    expect(parseContributionQuery({ groupBy: "team" }).ok).toBe(false);
    expect(parseContributionQuery({ from: "nope" }).ok).toBe(false);
    expect(parseContributionQuery({ from: "2026-02-01", to: "2026-01-01" }).ok).toBe(false);
  });
});
