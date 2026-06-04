import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from "../db/index.js";
import { runAutoStart, type AutoStartDeps } from "../startup/monitor-auto-start.js";

function makeSelectChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const fn of ["from", "where", "innerJoin", "leftJoin", "orderBy"]) {
    chain[fn] = () => chain;
  }
  chain.limit = () => Promise.resolve(result);
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  chain.catch = (fn: (e: unknown) => unknown) => Promise.resolve(result).catch(fn);
  return chain;
}

function makeDeps(overrides: Partial<AutoStartDeps> = {}): AutoStartDeps {
  return {
    serverPort: 3001,
    boardEvents: { broadcast: vi.fn() } as unknown as AutoStartDeps["boardEvents"],
    logMonitorAction: vi.fn(),
    allowProject: () => true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});

describe("runAutoStart dependency resolution", () => {
  it("does not treat a workflow blocker as resolved from the derived status column", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-1", title: "Dependent", projectId: "proj-1", issueNumber: 42 }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ id: "done-1" }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // no-auto-start tag check (none)
      .mockReturnValueOnce(makeSelectChain([{ dependsOnId: "blocker-1" }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{
        statusId: "done-1",
        currentNodeId: "node-build",
        currentNodeType: "normal",
      }]) as ReturnType<typeof db.select>);

    await runAutoStart(new Map([
      ["nudge_auto_start", "true"],
      ["nudge_wip_limit", "5"],
    ]), makeDeps());

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("runAutoStart URL construction", () => {
  it("uses 127.0.0.1 for monitor self-fetches", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-1", title: "Ready", description: "", issueNumber: 7 }]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // no-auto-start tag check (none)
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }]) as ReturnType<typeof db.select>);
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    await runAutoStart(new Map([
      ["nudge_auto_start", "true"],
      ["nudge_wip_limit", "1"],
    ]), makeDeps());

    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/workspaces",
      expect.any(Object),
    );
  });
});

describe("runAutoStart opt-out + scoping", () => {
  it("skips an In-Progress issue tagged no-auto-start", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // activeWip
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-1", title: "Tagged", description: "", issueNumber: 9 }]) as ReturnType<typeof db.select>) // inProgressIssues
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // openWs (none)
      .mockReturnValueOnce(makeSelectChain([{ id: "tag-1" }]) as ReturnType<typeof db.select>) // no-auto-start tag PRESENT
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]) as ReturnType<typeof db.select>) // Todo loop inProgressCount
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>); // todoStatus (none) -> loop ends

    await runAutoStart(new Map([["nudge_auto_start", "true"], ["nudge_wip_limit", "5"]]), makeDeps());
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("does not auto-start projects the allowProject predicate rejects", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }]) as ReturnType<typeof db.select>); // inProgressStatuses (filtered out)
    await runAutoStart(new Map([["nudge_auto_start", "true"]]), makeDeps({ allowProject: () => false }));
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
