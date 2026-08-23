/**
 * #790 — a card must not present a base-tip zero as a fact.
 *
 * #784 fixed this one level up: `GET /api/workspaces/:id/diff` lands a running remote
 * session's work on demand, so the endpoint every human and CLI uses is correct. The two
 * readers that compute the same numbers WITHOUT that route — the per-card diff-stat in
 * `board-status-enrichment.ts` and the workspace summary's git projection — still read the
 * board's worktree, which for a git-transport session is the base tip until exit.
 *
 * THE DECISION UNDER TEST is option 2 of the ticket: those paths do NOT get the landing. A
 * board rebuilds every card on a poll, including ones nobody is looking at, and giving that a
 * push-and-fast-forward per remote session would move the board's own worktree at moments
 * nothing asked for — exactly the cost #784's header argues against paying on a timer. So the
 * numbers stay as they are and the card gains the missing sentence.
 *
 * Which makes the first test below the important one: the hint must be FREE. If computing it
 * ever spawns git or asks a worker, option 2 has quietly become option 1 with worse ergonomics.
 */
import { describe, it, expect } from "vitest";
import type { BoardStatusIssue } from "@agentic-kanban/shared";
import {
  REMOTE_UNLANDED_LABEL,
  unlandedRemoteBranches,
  type RemoteUnlandedPort,
} from "../services/worker-remote-sync.service.js";
import { collectBoardStatusEntryWork } from "../services/board-status-enrichment.js";
import type { db } from "../db/index.js";

function portWith(
  rows: Array<{ sessionId: string; workerId: string; branch: string; repoPath: string }>,
): RemoteUnlandedPort {
  return { remoteGitTransportSessions: () => rows };
}

const REPO = "C:/repos/proj";

describe("#790 — which branches have work only a worker can see", () => {
  it("is synchronous and reads nothing but the session map", () => {
    // Not a style preference. This runs once per board build, for every workspace at once;
    // a promise here would mean a git spawn or a worker round trip had crept in.
    const map = unlandedRemoteBranches(
      portWith([{ sessionId: "s1", workerId: "w1", branch: "feature/ak-12", repoPath: REPO }]),
      { repoPath: REPO },
    );
    expect(map).toBeInstanceOf(Map);
    expect(map.get("feature/ak-12")).toEqual({
      workerId: "w1",
      sessionId: "s1",
      label: REMOTE_UNLANDED_LABEL,
    });
  });

  it("says nothing about a filesystem-sharing worker, which has nothing unlanded", () => {
    // Such a session has no `repo` at all, so the service never lists it — asserted here
    // because "remote" and "unlanded" are NOT the same predicate, and conflating them would
    // put a permanent warning on a card whose numbers are already live.
    expect(unlandedRemoteBranches(portWith([])).size).toBe(0);
  });

  it("filters by repo when the caller knows it, and is branch-only when it does not", () => {
    const rows = [
      { sessionId: "s1", workerId: "w1", branch: "feature/ak-12", repoPath: REPO },
      { sessionId: "s2", workerId: "w2", branch: "feature/ak-12", repoPath: "C:/repos/other" },
    ];
    expect([...unlandedRemoteBranches(portWith(rows), { repoPath: REPO }).keys()]).toEqual(["feature/ak-12"]);
    expect(unlandedRemoteBranches(portWith(rows), { repoPath: REPO }).get("feature/ak-12")?.workerId).toBe("w1");
    // No repoPath: the branch still resolves. The documented worst case is an over-warning on
    // a card that is actually current — never a wrong number.
    expect(unlandedRemoteBranches(portWith(rows)).size).toBe(1);
  });

  it("degrades to silence when there is no fleet, rather than failing a board build", () => {
    expect(unlandedRemoteBranches(null).size).toBe(0);
    expect(unlandedRemoteBranches(undefined).size).toBe(0);
    expect(unlandedRemoteBranches({} as unknown as RemoteUnlandedPort).size).toBe(0);
    const throwing: RemoteUnlandedPort = {
      remoteGitTransportSessions: () => {
        throw new Error("no fleet in this process");
      },
    };
    expect(unlandedRemoteBranches(throwing).size).toBe(0);
  });
});

describe("#790 — the board-status card carries the hint beside the numbers", () => {
  const workspace = {
    id: "ws-1",
    branch: "feature/ak-12",
    status: "active",
    workingDir: "C:/repos/proj/../wt",
    baseBranch: "master",
    isDirect: false,
  };

  function enrich(remote: ReturnType<typeof unlandedRemoteBranches> | undefined): BoardStatusIssue {
    const entry = { diffStats: null } as unknown as BoardStatusIssue;
    // The returned promises are the diff/conflict/output work; this test is about what the
    // function sets SYNCHRONOUSLY, which is the whole point — the flag and the numbers it
    // qualifies must never be able to arrive separately.
    collectBoardStatusEntryWork(entry, workspace, null, {
      defaultBranch: "master",
      database: {} as unknown as typeof db,
      tailLines: 5,
      conflictCache: new Map(),
      conflictCacheTtl: 1000,
      ...(remote ? { remoteUnlandedByBranch: remote } : {}),
    });
    return entry;
  }

  it("marks a card whose branch is live on a worker", () => {
    const entry = enrich(
      unlandedRemoteBranches(portWith([{ sessionId: "s1", workerId: "w1", branch: "feature/ak-12", repoPath: REPO }])),
    );
    expect(entry.remoteUnlanded).toEqual({ workerId: "w1", sessionId: "s1", label: REMOTE_UNLANDED_LABEL });
  });

  it("leaves an ordinary host workspace completely untouched", () => {
    // The regression this guards: a hint that appears on every card makes every card's
    // numbers untrustworthy, which is worse than the silent zero it replaced.
    expect(enrich(undefined).remoteUnlanded).toBeUndefined();
    expect(enrich(new Map()).remoteUnlanded).toBeUndefined();
  });
});
