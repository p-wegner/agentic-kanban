/**
 * #361 — a merged, gate-approved, Done pipeline unit was relaunched into a whole second workspace.
 *
 * Measured on kassenbuch step-6 (issue #6, merge `cd4aae9`, `mergedAt` 20:06:58, gate approved
 * 20:11:44, ticket Done, workspace closed):
 *
 * | time (UTC) | event |
 * |---|---|
 * | 20:18:22 | issue #6 -> In Progress, loop `openTickets` -> 2 |
 * | 20:22:16 | relaunch workspace `…-skel-r2` created |
 * | 20:24:45 | issue #6 -> Done, `openTickets` -> 1 |
 * | 20:25:22 | `-r2` workspace last touched, left idle, never merged |
 *
 * WHAT set the status at 20:18:22 is still unproven, and the ticket says not to fix against a
 * guessed cause. This test does not need it: `reopenRetryBranch` (the only producer of the `-r2`
 * suffix) lives in `monitor-auto-start`, so the relaunch definitely came from the reopen-retry path
 * (#265) — and for a plugin-loop unit that path is wrong whatever fed it. The loop dedupes on
 * `external_key` and never re-plans a unit that already has a ticket, so work done in a second
 * workspace can never be represented in the loop, while it inflates `openTickets` (the value the
 * monitor gates advancing on) and leaves a branch and worktree behind.
 *
 * HISTORY OF THIS FILE — why it drives `runAutoStart` now. It used to assert only on
 * `parsePluginLoopUnitKey`, i.e. on a shared-package helper the guard happens to call. That test
 * passed with BOTH `if (parsePluginLoopUnitKey(...))` sites in `monitor-auto-start.ts` short-circuited
 * to `false` — measured, 3/3 passed — so it could never have caught the defect coming back. Both
 * reopen-retry sites are now exercised end-to-end through `runAutoStart`, asserting on the thing the
 * defect actually consisted of: an HTTP workspace launch on a `-r2` branch. Keep it that way; a
 * predicate-only assertion here is indistinguishable from no test at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: { select: vi.fn() } }));
vi.mock("../services/worker-fleet.service.js", () => ({
  projectCanDispatch: vi.fn(async () => ({ available: true })),
}));
const reconcileMergedIssueMock = vi.fn();
vi.mock("../services/merge-cleanup.service.js", () => ({
  reconcileMergedIssue: (...args: unknown[]) => reconcileMergedIssueMock(...args),
}));

import { parsePluginLoopUnitKey, pluginLoopUnitKey } from "@agentic-kanban/shared/lib/plugin-manifest";
import { db } from "../db/index.js";
import { runAutoStart, type AutoStartDeps } from "../startup/monitor-auto-start.js";
import { openFileContentionGate } from "../startup/monitor-file-contention.js";

/** The exact `external_key` the kassenbuch step-6 unit carried. */
const LOOP_UNIT_KEY = pluginLoopUnitKey("pm-pipeline", "pipeline", "step-6:v1");
/** Its title, so the `-r2` branch this test asserts on is the one that was really observed. */
const UNIT_TITLE = "PM pipeline 6/9: Code generation MVP skeleton";
const MERGED_AT = "2026-08-01T20:06:58.000Z";

function makeSelectChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const fn of ["from", "where", "innerJoin", "leftJoin", "orderBy"]) chain[fn] = () => chain;
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
    buildContentionGate: async () => openFileContentionGate(),
    ...overrides,
  };
}

const PREFS = new Map([["nudge_auto_start", "true"], ["nudge_wip_limit", "2"]]);

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  vi.stubGlobal("fetch", vi.fn());
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ id: "ws-new" }) } as Response);
  reconcileMergedIssueMock.mockReset();
  // The reopen-after-merge verdict (#265). This is the ONLY state in which the guard matters:
  // a merged workspace plus a status changed after the merge.
  reconcileMergedIssueMock.mockResolvedValue({
    projectId: "proj-1", issueTransitioned: false, targetStatusId: "todo-1", reopenedAfterMerge: true,
  });
});

describe("#361: runAutoStart declines the reopen-retry for a plugin-loop unit", () => {
  /**
   * In-Progress backfill loop. The trailing `mockReturnValue([])` matters: with the guard ACTIVE the
   * cycle consumes one fewer query than without it (it `continue`s before the no-auto-start tag
   * lookup), so the sequence must not depend on the guard's own control flow.
   */
  function primeInProgress(externalKey: string | null) {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }])) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ active: 0, inactiveStale: 1 }])) // loop1 capacity
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-6", title: UNIT_TITLE, description: "d", issueType: "bug", issueNumber: 6, externalKey }])) // inProgressIssues
      .mockReturnValueOnce(makeSelectChain([{ id: "ws-1", status: "closed", mergedAt: MERGED_AT }])) // issueWorkspaces
      .mockReturnValue(makeSelectChain([])); // no tag, no todo status -> cycle ends
  }

  /** Todo/Backlog pull loop — the second, independently reachable reopen-retry site. */
  function primeTodo(externalKey: string | null) {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ id: "ip-1", projectId: "proj-1" }])) // inProgressStatuses
      .mockReturnValueOnce(makeSelectChain([{ active: 0, inactiveStale: 0 }])) // loop1 capacity
      .mockReturnValueOnce(makeSelectChain([])) // inProgressIssues (none)
      .mockReturnValueOnce(makeSelectChain([{ active: 0, inactiveStale: 1 }])) // loop2 capacity
      .mockReturnValueOnce(makeSelectChain([{ id: "todo-1" }])) // todoStatus
      .mockReturnValueOnce(makeSelectChain([{ id: "issue-6", title: UNIT_TITLE, description: "d", issueType: "bug", projectId: "proj-1", issueNumber: 6, externalKey }])) // todoIssues
      .mockReturnValueOnce(makeSelectChain([{ id: "done-1" }])) // doneStatuses
      .mockReturnValueOnce(makeSelectChain([{ id: "ws-1", status: "closed", mergedAt: MERGED_AT }])) // issueWorkspaces
      .mockReturnValue(makeSelectChain([])); // no tag, no deps
  }

  it("starts NO second workspace for a reopened, already-merged loop unit found In Progress", async () => {
    primeInProgress(LOOP_UNIT_KEY);

    const skips = await runAutoStart(PREFS, makeDeps());

    // The defect WAS this fetch: a `POST /api/workspaces` on the `-r2` branch.
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(skips.get("proj-1")?.reasonCounts.loop_unit_reopen_declined).toBe(1);
  });

  it("starts NO second workspace for a reopened, already-merged loop unit found in Todo", async () => {
    primeTodo(LOOP_UNIT_KEY);

    const skips = await runAutoStart(PREFS, makeDeps());

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(skips.get("proj-1")?.reasonCounts.loop_unit_reopen_declined).toBe(1);
  });

  // Negative controls: the guard must be narrow. If these ever go red, #265's reopen-retry has been
  // broken for ordinary tickets — which is a worse regression than #361 itself.
  it("still restarts an ordinary (non-loop) reopened issue from In Progress, on a fresh -r2 branch", async () => {
    primeInProgress(null);

    const skips = await runAutoStart(PREFS, makeDeps());

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.issueId).toBe("issue-6");
    expect(body.branch).toBe("feature/ak-6-pm-pipeline-6-9-code-generation-mvp-skel-r2");
    expect(skips.get("proj-1")?.reasonCounts.loop_unit_reopen_declined).toBeUndefined();
  });

  it("still restarts an ordinary (non-loop) reopened issue from Todo", async () => {
    primeTodo(null);

    await runAutoStart(PREFS, makeDeps());

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.branch).toBe("feature/ak-6-pm-pipeline-6-9-code-generation-mvp-skel-r2");
  });
});

describe("#361: the guard's predicate", () => {
  it("recognises the exact key shape the kassenbuch unit carried", () => {
    expect(LOOP_UNIT_KEY).toBe("plugin-loop:pm-pipeline:pipeline:step-6:v1");
    expect(parsePluginLoopUnitKey(LOOP_UNIT_KEY)).toEqual({
      pluginSlug: "pm-pipeline", loopName: "pipeline", unitId: "step-6:v1",
    });
  });

  it("does NOT catch an ordinary ticket, so #265's reopen-retry still works", () => {
    for (const externalKey of [null, undefined, "", "JIRA-123", "gh-456", "plugin-loop", "plugin-loop:"]) {
      expect(parsePluginLoopUnitKey(externalKey), `"${String(externalKey)}" must not be read as a loop unit`).toBeNull();
    }
  });

  it("recognises a unit id containing colons — the pipeline's own versioned ids do", () => {
    // `step-6:v1` puts a colon in the TAIL; a naive 4-way split would misparse it and the guard
    // would then let exactly the observed relaunch through.
    expect(parsePluginLoopUnitKey("plugin-loop:reqextract:extract:billing:r3")?.unitId).toBe("billing:r3");
  });
});
