import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issues, projectStatuses, projects } from "@agentic-kanban/shared/schema";

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
}));

import { db as mockedDb } from "../db/index.js";
import { runBacklogEmptyStrategy, type BacklogEmptyDeps } from "../startup/monitor-backlog.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

// Chainable drizzle-style select builder resolving to `result`.
function makeSelectChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const fn of ["from", "where", "innerJoin", "orderBy"]) chain[fn] = () => chain;
  chain.limit = () => Promise.resolve(result);
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  chain.catch = (fn: (e: unknown) => unknown) => Promise.resolve(result).catch(fn);
  return chain;
}

function makeInsertChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.values = () => chain;
  chain.returning = () => {
    const p = Promise.resolve(result) as Promise<unknown[]> & { catch: (fn: unknown) => unknown };
    return p;
  };
  return chain;
}

function makeDeleteChain() {
  const chain: Record<string, unknown> = {};
  chain.where = () => ({ catch: () => Promise.resolve() });
  return chain;
}

function makeDeps(overrides: Partial<BacklogEmptyDeps> = {}): BacklogEmptyDeps & { setCooldownStamp: ReturnType<typeof vi.fn> } {
  return {
    serverPort: 3001,
    boardEvents: { broadcast: vi.fn() } as unknown as BacklogEmptyDeps["boardEvents"],
    logMonitorAction: vi.fn(),
    setCooldownStamp: vi.fn().mockResolvedValue(undefined),
    // Cooldown timestamp is runtime state (#975); default to "no prior run".
    getCooldownStamp: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as BacklogEmptyDeps & { setCooldownStamp: ReturnType<typeof vi.fn> };
}

async function seedMonitorProject(database: TestDb) {
  const now = new Date("2026-06-06T20:00:00.000Z").toISOString();
  const projectId = randomUUID();
  await database.insert(projects).values({
    id: projectId,
    name: "Monitor Eligibility Project",
    repoPath: "/tmp/monitor-eligibility",
    repoName: "monitor-eligibility",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });

  const statusIds: Record<string, string> = {};
  for (const [sortOrder, name] of ["Todo", "In Progress"].entries()) {
    const id = randomUUID();
    statusIds[name] = id;
    await database.insert(projectStatuses).values({
      id,
      projectId,
      name,
      sortOrder,
      isDefault: name === "Todo",
      createdAt: now,
    });
  }

  return { projectId, statusIds };
}

async function insertMonitorIssue(database: TestDb, input: {
  projectId: string;
  statusId: string;
  issueNumber: number;
  title: string;
  issueType?: string;
}) {
  const now = new Date("2026-06-06T20:00:00.000Z").toISOString();
  await database.insert(issues).values({
    id: randomUUID(),
    projectId: input.projectId,
    statusId: input.statusId,
    issueNumber: input.issueNumber,
    title: input.title,
    description: "",
    priority: "medium",
    issueType: input.issueType ?? "task",
    sortOrder: input.issueNumber,
    createdAt: now,
    updatedAt: now,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});

describe("runBacklogEmptyStrategy — gating", () => {
  it("does nothing when strategy is 'skip'", async () => {
    const deps = makeDeps();
    await runBacklogEmptyStrategy(new Map([["backlog_empty_strategy", "skip"]]), deps);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(vi.mocked(mockedDb.select)).not.toHaveBeenCalled();
  });

  it("does nothing when strategy is unset", async () => {
    const deps = makeDeps();
    await runBacklogEmptyStrategy(new Map(), deps);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("respects the cooldown window", async () => {
    const now = new Date("2026-05-30T12:00:00.000Z").toISOString();
    const lastRun = new Date("2026-05-30T11:30:00.000Z").toISOString(); // 30 min ago, cooldown 120
    const deps = makeDeps({ getCooldownStamp: vi.fn().mockResolvedValue(lastRun) });
    const prefs = new Map([
      ["backlog_empty_strategy", "generate_tickets"],
      ["backlog_empty_cooldown_min", "120"],
    ]);
    await runBacklogEmptyStrategy(prefs, deps, now);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(vi.mocked(mockedDb.select)).not.toHaveBeenCalled();
  });
});

describe("runBacklogEmptyStrategy — generation", () => {
  it("launches the skill workspace and stamps cooldown when backlog is empty", async () => {
    vi.mocked(mockedDb.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof mockedDb.select>) // In Progress statuses
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof mockedDb.select>)                    // Todo status
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof mockedDb.select>)                        // backlog count = 0
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof mockedDb.select>)                        // WIP count = 0
      .mockReturnValueOnce(makeSelectChain([{ max: 41 }]) as ReturnType<typeof mockedDb.select>);                        // next issue number
    vi.mocked(mockedDb.insert).mockReturnValue(makeInsertChain([{ id: "host-issue-1" }]) as ReturnType<typeof mockedDb.insert>);
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "ws-9" }) } as unknown as Response);

    const deps = makeDeps();
    const now = new Date("2026-05-30T12:00:00.000Z").toISOString();
    await runBacklogEmptyStrategy(new Map([["backlog_empty_strategy", "generate_tickets"]]), deps, now);

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.length).toBe(1);
    const [url, init] = calls[0];
    expect(String(url)).toBe("http://127.0.0.1:3001/api/workspaces");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.issueId).toBe("host-issue-1");
    expect(body.skillName).toBe("architecture-improvement");
    expect(body.customPrompt).toContain("create_issue");
    expect(body.customPrompt).toContain("NO cloud dependencies");

    expect(vi.mocked(deps.logMonitorAction)).toHaveBeenCalledWith("generate_tickets", "ws-9", "host-issue-1");
    expect(vi.mocked(deps.boardEvents.broadcast)).toHaveBeenCalledWith("proj-1", "board_changed");
    expect(deps.setCooldownStamp).toHaveBeenCalledWith(now);
  });

  it("does NOT generate when the backlog still has unstarted issues", async () => {
    vi.mocked(mockedDb.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof mockedDb.select>) // In Progress statuses
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof mockedDb.select>)                    // Todo status
      .mockReturnValueOnce(makeSelectChain([{ count: 3 }]) as ReturnType<typeof mockedDb.select>);                       // backlog count = 3

    const deps = makeDeps();
    await runBacklogEmptyStrategy(new Map([["backlog_empty_strategy", "generate_tickets"]]), deps);

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(deps.setCooldownStamp).not.toHaveBeenCalled();
  });

  it("does NOT generate when WIP is at the limit", async () => {
    vi.mocked(mockedDb.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof mockedDb.select>) // In Progress statuses
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof mockedDb.select>)                    // Todo status
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof mockedDb.select>)                        // backlog count = 0
      .mockReturnValueOnce(makeSelectChain([{ count: 5 }]) as ReturnType<typeof mockedDb.select>);                       // WIP count = 5 (== limit)

    const deps = makeDeps();
    await runBacklogEmptyStrategy(new Map([
      ["backlog_empty_strategy", "generate_tickets"],
      ["nudge_wip_limit", "5"],
    ]), deps);

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(deps.setCooldownStamp).not.toHaveBeenCalled();
  });

  it("uses the configured skill name", async () => {
    vi.mocked(mockedDb.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof mockedDb.select>)
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof mockedDb.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof mockedDb.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof mockedDb.select>)
      .mockReturnValueOnce(makeSelectChain([{ max: 0 }]) as ReturnType<typeof mockedDb.select>);
    vi.mocked(mockedDb.insert).mockReturnValue(makeInsertChain([{ id: "host-issue-2" }]) as ReturnType<typeof mockedDb.insert>);
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "ws-1" }) } as unknown as Response);

    const deps = makeDeps();
    await runBacklogEmptyStrategy(new Map([
      ["backlog_empty_strategy", "generate_tickets"],
      ["backlog_empty_skill", "ui-explorer"],
    ]), deps);

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.skillName).toBe("ui-explorer");
  });

  it("deletes the orphan host issue and does not stamp cooldown when workspace launch fails", async () => {
    vi.mocked(mockedDb.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof mockedDb.select>)
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof mockedDb.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof mockedDb.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof mockedDb.select>)
      .mockReturnValueOnce(makeSelectChain([{ max: 0 }]) as ReturnType<typeof mockedDb.select>);
    vi.mocked(mockedDb.insert).mockReturnValue(makeInsertChain([{ id: "host-issue-3" }]) as ReturnType<typeof mockedDb.insert>);
    vi.mocked(mockedDb.delete).mockReturnValue(makeDeleteChain() as ReturnType<typeof mockedDb.delete>);
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({}) } as unknown as Response);

    const deps = makeDeps();
    await runBacklogEmptyStrategy(new Map([["backlog_empty_strategy", "generate_tickets"]]), deps);

    expect(vi.mocked(mockedDb.delete)).toHaveBeenCalled();
    expect(deps.setCooldownStamp).not.toHaveBeenCalled();
    expect(vi.mocked(deps.logMonitorAction)).not.toHaveBeenCalled();
  });

  it("refills when total Todo is above the floor but eligible non-feature backlog is below it", async () => {
    const { client, db: realDb } = createTestDb();
    try {
      const { projectId, statusIds } = await seedMonitorProject(realDb);
      await insertMonitorIssue(realDb, { projectId, statusId: statusIds.Todo, issueNumber: 1, title: "Feature: add dashboard", issueType: "feature" });
      await insertMonitorIssue(realDb, { projectId, statusId: statusIds.Todo, issueNumber: 2, title: "new board filters", issueType: "enhancement" });
      await insertMonitorIssue(realDb, { projectId, statusId: statusIds.Todo, issueNumber: 3, title: "Feature: workspace presets", issueType: "feature" });
      await insertMonitorIssue(realDb, { projectId, statusId: statusIds.Todo, issueNumber: 4, title: "bug: fix monitor crash", issueType: "bug" });
      await insertMonitorIssue(realDb, { projectId, statusId: statusIds.Todo, issueNumber: 5, title: "quality: cover startup monitor" });
      await insertMonitorIssue(realDb, { projectId, statusId: statusIds.Todo, issueNumber: 6, title: "architecture: split monitor policy helper" });

      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "ws-refill" }) } as unknown as Response);
      const deps = makeDeps({
        database: realDb as unknown as typeof mockedDb,
        createHostIssue: vi.fn().mockResolvedValue("host-issue-real"),
      });

      const prefs = new Map([
        ["backlog_empty_strategy", "generate_tickets"],
        [`board_strategy_${projectId}`, JSON.stringify({ version: 1, activeAgentsTarget: 4, backlogFloor: 4, maxNewStartsPerCycle: 2, segments: [] })],
      ]);
      await runBacklogEmptyStrategy(prefs, deps, "2026-06-06T21:00:00.000Z");

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(deps.logMonitorAction)).toHaveBeenCalledWith("generate_tickets", "ws-refill", "host-issue-real");
      expect(deps.setCooldownStamp).toHaveBeenCalledWith("2026-06-06T21:00:00.000Z");
    } finally {
      client.close();
    }
  });
});
