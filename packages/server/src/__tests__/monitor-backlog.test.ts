import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
}));

import { db } from "../db/index.js";
import { runBacklogEmptyStrategy, type BacklogEmptyDeps } from "../startup/monitor-backlog.js";

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
    ...overrides,
  } as BacklogEmptyDeps & { setCooldownStamp: ReturnType<typeof vi.fn> };
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
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });

  it("does nothing when strategy is unset", async () => {
    const deps = makeDeps();
    await runBacklogEmptyStrategy(new Map(), deps);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("respects the cooldown window", async () => {
    const deps = makeDeps();
    const now = new Date("2026-05-30T12:00:00.000Z").toISOString();
    const lastRun = new Date("2026-05-30T11:30:00.000Z").toISOString(); // 30 min ago, cooldown 120
    const prefs = new Map([
      ["backlog_empty_strategy", "generate_tickets"],
      ["backlog_empty_cooldown_min", "120"],
      ["backlog_empty_last_run", lastRun],
    ]);
    await runBacklogEmptyStrategy(prefs, deps, now);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });
});

describe("runBacklogEmptyStrategy — generation", () => {
  it("launches the skill workspace and stamps cooldown when backlog is empty", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>) // In Progress statuses
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof db.select>)                    // Todo status
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>)                        // backlog count = 0
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>)                        // WIP count = 0
      .mockReturnValueOnce(makeSelectChain([{ max: 41 }]) as ReturnType<typeof db.select>);                        // next issue number
    vi.mocked(db.insert).mockReturnValue(makeInsertChain([{ id: "host-issue-1" }]) as ReturnType<typeof db.insert>);
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "ws-9" }) } as unknown as Response);

    const deps = makeDeps();
    const now = new Date("2026-05-30T12:00:00.000Z").toISOString();
    await runBacklogEmptyStrategy(new Map([["backlog_empty_strategy", "generate_tickets"]]), deps, now);

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.length).toBe(1);
    const [url, init] = calls[0];
    expect(String(url)).toContain("/api/workspaces");
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
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>) // In Progress statuses
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof db.select>)                    // Todo status
      .mockReturnValueOnce(makeSelectChain([{ count: 3 }]) as ReturnType<typeof db.select>);                       // backlog count = 3

    const deps = makeDeps();
    await runBacklogEmptyStrategy(new Map([["backlog_empty_strategy", "generate_tickets"]]), deps);

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(deps.setCooldownStamp).not.toHaveBeenCalled();
  });

  it("does NOT generate when WIP is at the limit", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>) // In Progress statuses
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof db.select>)                    // Todo status
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>)                        // backlog count = 0
      .mockReturnValueOnce(makeSelectChain([{ count: 5 }]) as ReturnType<typeof db.select>);                       // WIP count = 5 (== limit)

    const deps = makeDeps();
    await runBacklogEmptyStrategy(new Map([
      ["backlog_empty_strategy", "generate_tickets"],
      ["nudge_wip_limit", "5"],
    ]), deps);

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(deps.setCooldownStamp).not.toHaveBeenCalled();
  });

  it("uses the configured skill name", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ max: 0 }]) as ReturnType<typeof db.select>);
    vi.mocked(db.insert).mockReturnValue(makeInsertChain([{ id: "host-issue-2" }]) as ReturnType<typeof db.insert>);
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
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ max: 0 }]) as ReturnType<typeof db.select>);
    vi.mocked(db.insert).mockReturnValue(makeInsertChain([{ id: "host-issue-3" }]) as ReturnType<typeof db.insert>);
    vi.mocked(db.delete).mockReturnValue(makeDeleteChain() as ReturnType<typeof db.delete>);
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({}) } as unknown as Response);

    const deps = makeDeps();
    await runBacklogEmptyStrategy(new Map([["backlog_empty_strategy", "generate_tickets"]]), deps);

    expect(vi.mocked(db.delete)).toHaveBeenCalled();
    expect(deps.setCooldownStamp).not.toHaveBeenCalled();
    expect(vi.mocked(deps.logMonitorAction)).not.toHaveBeenCalled();
  });
});
