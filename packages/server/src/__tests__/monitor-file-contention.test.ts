import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: { select: vi.fn() } }));

import { db } from "../db/index.js";
import { runAutoStart, type AutoStartDeps } from "../startup/monitor-auto-start.js";
import {
  buildFileContentionGate,
  inFlightWorkspacePredicate,
  openFileContentionGate,
  shouldDeferForContention,
} from "../startup/monitor-file-contention.js";

function makeSelectChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const fn of ["from", "where", "innerJoin", "leftJoin", "orderBy"]) chain[fn] = () => chain;
  chain.limit = () => Promise.resolve(result);
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  chain.catch = (fn: (e: unknown) => unknown) => Promise.resolve(result).catch(fn);
  return chain;
}

/** A fake database exposing only `select`, returning the queued results in order. */
function fakeDb(results: unknown[][]) {
  let i = 0;
  return { select: () => makeSelectChain(results[i++] ?? []) } as unknown as Pick<typeof db, "select">;
}

function touched(...paths: string[]) {
  return JSON.stringify(paths.map((path) => ({ path, reason: "r", confidence: "high" })));
}

const PROJECT = "proj-1";

beforeEach(() => {
  vi.restoreAllMocks();
  // `restoreAllMocks` does not drain a `mockReturnValueOnce` queue, so an unconsumed
  // mock from a previous test would shift the next test's whole sequence by one.
  vi.mocked(db.select).mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

describe("buildFileContentionGate (#119)", () => {
  // The dogfood scenario: ticket-a is in flight editing src/app.ts; ticket-b is a
  // correctly-sized, otherwise-disjoint backlog ticket that must also register
  // itself in src/app.ts.
  const projectIssues = [
    { id: "ticket-a", touchedFilesJson: touched("src/app.ts", "src/routes/tags.ts") },
    { id: "ticket-b", touchedFilesJson: touched("src/app.ts", "src/routes/labels.ts") },
    { id: "ticket-c", touchedFilesJson: touched("docs/readme.md") },
  ];

  it("defers a candidate that would collide with an in-flight ticket on a registration file", async () => {
    const gate = await buildFileContentionGate(
      new Map(),
      PROJECT,
      fakeDb([projectIssues, [{ issueId: "ticket-a" }]]),
    );
    expect(gate.mode).toBe("serialize");
    const verdict = gate.check("ticket-b");
    expect(verdict?.hotFiles).toEqual(["src/app.ts"]);
    expect(verdict?.blockingIssueIds).toEqual(["ticket-a"]);
  });

  it("lets a disjoint candidate through", async () => {
    const gate = await buildFileContentionGate(
      new Map(),
      PROJECT,
      fakeDb([projectIssues, [{ issueId: "ticket-a" }]]),
    );
    expect(gate.check("ticket-c")).toBeNull();
  });

  it("lets everything through when nothing is in flight", async () => {
    const gate = await buildFileContentionGate(new Map(), PROJECT, fakeDb([projectIssues, []]));
    expect(gate.check("ticket-b")).toBeNull();
  });

  it("fails open for an issue with no cached prediction (never triggers analysis)", async () => {
    const gate = await buildFileContentionGate(
      new Map(),
      PROJECT,
      fakeDb([[...projectIssues, { id: "ticket-d", touchedFilesJson: null }], [{ issueId: "ticket-a" }]]),
    );
    expect(gate.check("ticket-d")).toBeNull();
  });

  it("fails open when the project has no predictions at all", async () => {
    const gate = await buildFileContentionGate(new Map(), PROJECT, fakeDb([[{ id: "x", touchedFilesJson: null }]]));
    expect(gate.check("x")).toBeNull();
  });

  it("skips all queries and stays open when the project opts out", async () => {
    const select = vi.fn();
    const gate = await buildFileContentionGate(
      new Map([[`file_contention_${PROJECT}`, "off"]]),
      PROJECT,
      { select } as unknown as Pick<typeof db, "select">,
    );
    expect(gate.mode).toBe("off");
    expect(gate.check("ticket-b")).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it("fails open when the snapshot query throws", async () => {
    const gate = await buildFileContentionGate(new Map(), PROJECT, {
      select: () => { throw new Error("db down"); },
    } as unknown as Pick<typeof db, "select">);
    expect(gate.check("ticket-b")).toBeNull();
  });

  it("noteStarted makes a same-cycle launch visible to later candidates", async () => {
    // Nothing in flight, so ticket-b is initially clear. Once ticket-a launches
    // THIS cycle, ticket-b must be deferred — otherwise the gate would be useless
    // for the common case of two backlog tickets pulled in one cycle.
    const gate = await buildFileContentionGate(new Map(), PROJECT, fakeDb([projectIssues, []]));
    expect(gate.check("ticket-b")).toBeNull();
    gate.noteStarted("ticket-a");
    expect(gate.check("ticket-b")?.hotFiles).toEqual(["src/app.ts"]);
  });

  // Regression: the gate originally reused AUTO_START_WIP_STATUSES
  // (active/reviewing/fixing), which #690 narrowed for WIP *capacity* accounting.
  // Contention is not about a live agent — a workspace in `ready_for_merge` or
  // `idle` has already WRITTEN the registration file and is sitting on an unmerged
  // branch. That is the peak contention window, and scoping to the WIP set made the
  // gate blind to the exact #119 case. The query must select every non-closed
  // workspace; these tests pin that by feeding rows the old predicate excluded.
  it.each(["ready_for_merge", "idle", "blocked", "awaiting-plan-approval", "error"])(
    "defers against an in-flight ticket whose workspace is %s (unmerged branch still holds the file)",
    async (status) => {
      const gate = await buildFileContentionGate(
        new Map(),
        PROJECT,
        // The fake db returns whatever the query selects; the real filtering lives in
        // SQL, so this asserts the row SHAPE is honoured for non-WIP statuses.
        fakeDb([projectIssues, [{ issueId: "ticket-a", status }]]),
      );
      expect(gate.check("ticket-b")?.hotFiles).toEqual(["src/app.ts"]);
    },
  );

  it("noteStarted ignores an issue with no prediction", async () => {
    const gate = await buildFileContentionGate(new Map(), PROJECT, fakeDb([projectIssues, []]));
    gate.noteStarted("unknown-issue");
    expect(gate.check("ticket-b")).toBeNull();
  });
});

describe("in-flight scope (review regressions)", () => {
  /**
   * Flatten a drizzle SQL fragment to a string so its scope can be asserted.
   *
   * Must NOT use JSON.stringify: a fragment's chunks include Column objects, and
   * `column.table.column` is a cycle ("Converting circular structure to JSON").
   * Walk the tree instead, collecting only primitives and skipping Columns/Tables.
   */
  function sqlText(node: unknown, depth = 0): string {
    if (depth > 8 || node == null) return "";
    if (typeof node === "string") return node;
    if (typeof node === "number" || typeof node === "boolean") return String(node);
    if (Array.isArray(node)) return node.map((n) => sqlText(n, depth + 1)).join(" ");
    if (typeof node !== "object") return "";
    const o = node as Record<string, unknown>;
    if ("table" in o) return ""; // a Column — its identifier is irrelevant here
    const parts: string[] = [];
    if ("queryChunks" in o) parts.push(sqlText(o.queryChunks, depth + 1));
    if ("value" in o) parts.push(sqlText(o.value, depth + 1));
    return parts.join(" ");
  }

  // A workspace that has FINISHED writing src/app.ts and is waiting to merge
  // (`idle`, `ready_for_merge`, `blocked`) still holds the registration-file edit,
  // so a second builder starting into that window hits the #119 conflict. Scoping
  // the query to the WIP statuses (active/reviewing/fixing) — which exist to answer
  // "is an agent burning capacity?" — made the gate blind to the dominant case.
  it("counts every non-closed workspace, not just the live-agent WIP statuses", () => {
    const text = sqlText(inFlightWorkspacePredicate);
    expect(text).toContain("!= 'closed'");
    for (const wipOnly of ["active", "reviewing", "fixing"]) {
      expect(text).not.toContain(`'${wipOnly}'`);
    }
  });

  it("derives hot-file evidence from open issues only (excludes Done/Cancelled)", async () => {
    const where = vi.fn();
    const chain: Record<string, unknown> = {};
    for (const fn of ["from", "innerJoin", "orderBy"]) chain[fn] = () => chain;
    chain.where = (arg: unknown) => { where(arg); return chain; };
    chain.then = (r: (v: unknown) => unknown) => Promise.resolve([]).then(r);

    await buildFileContentionGate(new Map(), PROJECT, {
      select: () => chain,
    } as unknown as Pick<typeof db, "select">);

    // The issue-snapshot query must filter the status name, or a mature board's
    // Done issues inflate the >=3-issue hotness count until every file reads hot
    // and the gate throttles all parallelism.
    const filter = sqlText(where.mock.calls[0]?.[0]);
    expect(filter).toContain("Done");
    expect(filter).toContain("Cancelled");
  });
});

describe("shouldDeferForContention modes", () => {
  const projectIssues = [
    { id: "ticket-a", touchedFilesJson: touched("src/app.ts") },
    { id: "ticket-b", touchedFilesJson: touched("src/app.ts", "src/x.ts") },
  ];

  it("serialize mode defers and logs", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const gate = await buildFileContentionGate(new Map(), PROJECT, fakeDb([projectIssues, [{ issueId: "ticket-a" }]]));
    expect(shouldDeferForContention(gate, "ticket-b", 42)).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Deferring auto-start of issue #42"));
  });

  it("warn mode logs but starts anyway", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const gate = await buildFileContentionGate(
      new Map([[`file_contention_${PROJECT}`, "warn"]]),
      PROJECT,
      fakeDb([projectIssues, [{ issueId: "ticket-a" }]]),
    );
    expect(shouldDeferForContention(gate, "ticket-b", 42)).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("File contention (warn) for issue #42"));
  });

  it("an open gate never defers", () => {
    expect(shouldDeferForContention(openFileContentionGate(), "anything", 1)).toBe(false);
  });
});

describe("runAutoStart serializes on a shared registration file (#119 reproduction)", () => {
  function makeDeps(overrides: Partial<AutoStartDeps> = {}): AutoStartDeps {
    return {
      serverPort: 3001,
      boardEvents: { broadcast: vi.fn() } as unknown as AutoStartDeps["boardEvents"],
      logMonitorAction: vi.fn(),
      allowProject: () => true,
      ...overrides,
    };
  }

  /**
   * Two unblocked Todo tickets, both predicted to touch `src/app.ts`, with 2 free
   * WIP slots and a maxNewStartsPerCycle of 2. Before the fix BOTH launched in one
   * cycle and the second builder hit an adjacent-line conflict on `src/app.ts`,
   * burning an agent-driven fix-and-merge cycle. Now only the first launches; the
   * second waits for a later cycle.
   */
  function mockTwoContendingTodos() {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: PROJECT }]) as ReturnType<typeof db.select>) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ active: 0, inactiveStale: 0 }]) as ReturnType<typeof db.select>) // loop1 capacity
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // loop1 inProgressIssues (none)
      .mockReturnValueOnce(makeSelectChain([{ active: 0, inactiveStale: 0 }]) as ReturnType<typeof db.select>) // loop2 capacity
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }]) as ReturnType<typeof db.select>) // todoStatus
      .mockReturnValueOnce(makeSelectChain([
        { id: "ticket-a", title: "Add tags", projectId: PROJECT, issueNumber: 41 },
        { id: "ticket-b", title: "Add labels", projectId: PROJECT, issueNumber: 42 },
      ]) as ReturnType<typeof db.select>) // todoIssues
      .mockReturnValueOnce(makeSelectChain([{ id: "done-1" }]) as ReturnType<typeof db.select>) // doneStatuses
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // ticket-a existingWs
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // ticket-a tag
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // ticket-a deps
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // ticket-b existingWs
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>) // ticket-b tag
      // Only consumed when the gate lets ticket-b through (the opt-out case) —
      // in serialize mode the deferral happens before this query.
      .mockReturnValueOnce(makeSelectChain([]) as ReturnType<typeof db.select>); // ticket-b deps
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ id: "ws-new" }) } as Response);
  }

  const contendingProject = [
    { id: "ticket-a", touchedFilesJson: touched("src/app.ts", "src/routes/tags.ts") },
    { id: "ticket-b", touchedFilesJson: touched("src/app.ts", "src/routes/labels.ts") },
  ];

  const prefs = new Map([[
    "board_strategy_proj-1",
    JSON.stringify({ version: 1, activeAgentsTarget: 4, maxNewStartsPerCycle: 2 }),
  ]]);

  it("starts only the first of two tickets contending on src/app.ts", async () => {
    mockTwoContendingTodos();
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runAutoStart(prefs, makeDeps({
      buildContentionGate: (prefMap, projectId) =>
        buildFileContentionGate(prefMap, projectId, fakeDb([contendingProject, []])),
    }));

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.issueId).toBe("ticket-a");
  });

  it("starts BOTH when the project opts out of serialization (proves the gate is what defers)", async () => {
    mockTwoContendingTodos();

    await runAutoStart(prefs, makeDeps({
      buildContentionGate: (_prefMap, projectId) =>
        buildFileContentionGate(
          new Map([[`file_contention_${projectId}`, "off"]]),
          projectId,
          fakeDb([contendingProject, []]),
        ),
    }));

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
