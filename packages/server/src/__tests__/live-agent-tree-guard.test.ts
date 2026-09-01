// #968: a session was recorded `completed` with exit 0 while its claude.exe kept running and
// kept WORKING — it opened a new transcript after its recorded end, edited files and ran the
// full verify chain. The workspace therefore showed no running session, the driving session
// relaunched it, and two agents co-edited one worktree for ~20 minutes.
//
// Two things had to become true, and this suite pins both:
//   1. "the stream closed" and "the process is gone" are DIFFERENT facts, and the exit path
//      must not record the first as if it were the second.
//   2. `launchSession` must refuse when a previous session's process tree is still alive,
//      because the caller cannot see it — with a `force` override to keep the old behavior.
import { describe, it, expect, vi } from "vitest";
import { descendantsOf, probeProcessTree, type ProcessTableRow } from "../lib/process-tree.js";
import {
  findLiveAgentTrees,
  liveAgentRefusalMessage,
  pidStillIdentifiesSession,
  SURVIVOR_PROBE_WINDOW_MS,
  type SessionPidRow,
} from "../services/workspace-agent-liveness.service.js";

/** A table shaped like the #968 incident: the spawned pid is gone, its worker survives it. */
const ORPHANED_TREE: ProcessTableRow[] = [
  { pid: 1, ppid: 0 },
  { pid: 100, ppid: 1 }, // the pid the board spawned (already exited)
  { pid: 31344, ppid: 100 }, // claude.exe — the zombie that kept working
  { pid: 31500, ppid: 31344 }, // a vitest worker it spawned
  { pid: 900, ppid: 1 }, // an unrelated process, must never be attributed to us
];

describe("descendantsOf — the tree walk (#968)", () => {
  it("finds descendants through a parent that has already exited", () => {
    // This is the whole point: WMI still reports a survivor's ORIGINAL ParentProcessId after
    // the parent dies, which is how a reparented agent stays attributable to the pid we spawned.
    expect(descendantsOf(100, ORPHANED_TREE).sort()).toEqual([31344, 31500]);
  });

  it("never attributes an unrelated process to the tree", () => {
    expect(descendantsOf(100, ORPHANED_TREE)).not.toContain(900);
  });

  it("excludes the root itself — the caller decides whether the root counts", () => {
    expect(descendantsOf(100, ORPHANED_TREE)).not.toContain(100);
  });

  it("terminates on a self-parenting row rather than looping forever", () => {
    // pid 0 parenting itself is a real Windows artifact; a naive walk never returns.
    const table: ProcessTableRow[] = [{ pid: 0, ppid: 0 }, { pid: 5, ppid: 0 }];
    expect(descendantsOf(0, table)).toEqual([5]);
  });

  it("bounds depth so a cycle in the table cannot spin", () => {
    const table: ProcessTableRow[] = [
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 2 },
      { pid: 1, ppid: 3 }, // cycle back to the root
    ];
    expect(descendantsOf(1, table).sort()).toEqual([2, 3]);
  });
});

describe("probeProcessTree — three-valued, because 'cannot see' is not 'gone' (#968)", () => {
  it("reports ALIVE when the spawned pid exited but a descendant survives it", async () => {
    const verdict = await probeProcessTree(100, {
      enumerate: () => ORPHANED_TREE,
      checkPid: (pid) => pid === 31344 || pid === 31500,
    });
    expect(verdict.liveness).toBe("alive");
    expect(verdict.pids.sort()).toEqual([31344, 31500]);
    // The reason must name the pids — "something is still running" is not actionable.
    expect(verdict.reason).toContain("31344");
  });

  it("reports DEAD only when the root and every descendant are gone", async () => {
    const verdict = await probeProcessTree(100, { enumerate: () => ORPHANED_TREE, checkPid: () => false });
    expect(verdict.liveness).toBe("dead");
    expect(verdict.pids).toEqual([]);
  });

  it("reports UNKNOWN when the process table cannot be read and the root is gone", async () => {
    // Collapsing this into `dead` would reinstate the exact false 'completed' #968 is about.
    const verdict = await probeProcessTree(100, { enumerate: () => null, checkPid: () => false });
    expect(verdict.liveness).toBe("unknown");
  });

  it("still answers ALIVE with an unreadable table when the root itself is alive", async () => {
    const verdict = await probeProcessTree(100, { enumerate: () => null, checkPid: () => true });
    expect(verdict.liveness).toBe("alive");
    expect(verdict.pids).toEqual([100]);
  });

  it("treats an empty enumeration as unreadable, not as an empty machine", async () => {
    // No OS has zero processes; an empty parse means the output shape changed under us.
    const verdict = await probeProcessTree(100, { enumerate: () => [], checkPid: () => false });
    expect(verdict.liveness).toBe("unknown");
  });

  it("reports DEAD for a session that never held a pid", async () => {
    expect((await probeProcessTree(null)).liveness).toBe("dead");
    expect((await probeProcessTree(0)).liveness).toBe("dead");
  });

  it("answers on a REAL process table without blocking the event loop", async () => {
    // No injection: this drives the actual enumeration. `process.pid` is this test process, so
    // the only correct answer is `alive` — and the assertion below is the one that would fail
    // if the enumeration silently stopped working on this platform.
    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(Date.now()), 5);
    try {
      const verdict = await probeProcessTree(process.pid);
      expect(verdict.liveness).toBe("alive");
      expect(verdict.pids).toContain(process.pid);
      // A synchronous spawn would have starved the loop and left this empty — which is exactly
      // what a session exit and a launch request cannot afford.
      expect(ticks.length).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
  });
});

describe("findLiveAgentTrees — the relaunch guard's verdict (#968)", () => {
  const rows: SessionPidRow[] = [
    { id: "62c6722d", pid: 100 }, // recorded `completed`, exit 0 — and still working
    { id: "older", pid: 55 },
  ];

  it("finds a live tree under a session the board recorded as completed", async () => {
    // The defect IS that the status is unreliable, so status must not filter what is probed.
    const liveness = await findLiveAgentTrees(rows, {
      probeTree: (pid) =>
        pid === 100
          ? { liveness: "alive", pids: [31344], reason: `pid 100 exited but 1 descendant survives it: 31344` }
          : { liveness: "dead", pids: [], reason: "gone" },
    });
    expect(liveness.verdict).toBe("live");
    expect(liveness.trees).toHaveLength(1);
    expect(liveness.trees[0]!.sessionId).toBe("62c6722d");
    expect(liveness.trees[0]!.pids).toEqual([31344]);
  });

  it("is CLEAR when every prior host session has fully exited", async () => {
    const liveness = await findLiveAgentTrees(rows, {
      probeTree: () => ({ liveness: "dead", pids: [], reason: "gone" }),
    });
    expect(liveness.verdict).toBe("clear");
  });

  it("skips fleet sessions, which have no host pid and are the worker's question", async () => {
    const probeTree = vi.fn(() => ({ liveness: "dead" as const, pids: [], reason: "gone" }));
    const liveness = await findLiveAgentTrees([{ id: "remote", pid: null, workerId: "w1" }], { probeTree });
    expect(probeTree).not.toHaveBeenCalled();
    expect(liveness.verdict).toBe("clear");
  });

  it("reports UNKNOWN rather than clear when a probe could not answer", async () => {
    const liveness = await findLiveAgentTrees([{ id: "s", pid: 100 }], {
      probeTree: () => ({ liveness: "unknown", pids: [], reason: "could not enumerate" }),
    });
    expect(liveness.verdict).toBe("unknown");
  });

  it("prefers concrete evidence: a found tree outranks an unreadable one", async () => {
    const liveness = await findLiveAgentTrees(rows, {
      probeTree: (pid) =>
        pid === 100
          ? { liveness: "alive", pids: [31344], reason: "survivor" }
          : { liveness: "unknown", pids: [], reason: "could not enumerate" },
    });
    expect(liveness.verdict).toBe("live");
  });

  it("survives a throwing probe by degrading to unknown, never to clear", async () => {
    const liveness = await findLiveAgentTrees([{ id: "s", pid: 100 }], {
      probeTree: () => { throw new Error("boom"); },
    });
    expect(liveness.verdict).toBe("unknown");
  });

  it("reads the process table ONCE for the whole workspace, not once per session", async () => {
    // Without sharing, a workspace with several prior sessions pays a process enumeration
    // (a PowerShell spawn on Windows) per session on EVERY relaunch — and the snapshots could
    // disagree with each other, which is worse than the cost.
    const enumerate = vi.fn(async () => ORPHANED_TREE);
    const liveness = await findLiveAgentTrees(
      [{ id: "a", pid: 100 }, { id: "b", pid: 900 }, { id: "c", pid: 55 }],
      { enumerate, checkPid: (pid) => pid === 31344 },
    );
    expect(enumerate).toHaveBeenCalledTimes(1);
    // ...and the shared snapshot still yields the right answer: only session "a" owns 31344.
    expect(liveness.verdict).toBe("live");
    expect(liveness.trees.map((t) => t.sessionId)).toEqual(["a"]);
  });

  it("survives a REJECTING probe the same way — an async failure is still not evidence", async () => {
    const liveness = await findLiveAgentTrees([{ id: "s", pid: 100 }], {
      probeTree: () => Promise.reject(new Error("boom")),
    });
    expect(liveness.verdict).toBe("unknown");
  });
});

describe("the recency window — a stale pid must not block a relaunch forever (#968)", () => {
  // `sessions.pid` is never cleared, and a pid is not a durable identifier. Without a window,
  // a workspace whose session ended weeks ago holds a pid the OS has since recycled onto an
  // unrelated process: `isPidAlive` says yes, the guard says `live`, and `launchSession`
  // refuses FOREVER — including the monitor's auto-relaunch, which passes no `force`.
  const now = Date.parse("2026-09-01T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("probes a session that ended just now", () => {
    expect(pidStillIdentifiesSession({ id: "s", pid: 100, endedAt: ago(60_000) }, now)).toBe(true);
  });

  it("probes a session with no recorded end — the board still believes it is running", () => {
    expect(pidStillIdentifiesSession({ id: "s", pid: 100, endedAt: null }, now)).toBe(true);
    expect(pidStillIdentifiesSession({ id: "s", pid: 100 }, now)).toBe(true);
  });

  it("still probes at the exact edge of the window", () => {
    expect(pidStillIdentifiesSession({ id: "s", pid: 100, endedAt: ago(SURVIVOR_PROBE_WINDOW_MS) }, now)).toBe(true);
  });

  it("stops probing a session whose pid is old enough to have been recycled", () => {
    expect(pidStillIdentifiesSession({ id: "s", pid: 100, endedAt: ago(SURVIVOR_PROBE_WINDOW_MS + 1) }, now)).toBe(false);
    expect(pidStillIdentifiesSession({ id: "s", pid: 100, endedAt: ago(30 * 24 * 3600_000) }, now)).toBe(false);
  });

  it("probes rather than skips on an unparseable timestamp — a bad value is not evidence of staleness", () => {
    expect(pidStillIdentifiesSession({ id: "s", pid: 100, endedAt: "not a date" }, now)).toBe(true);
  });

  it("does not refuse a relaunch over a week-old session whose pid was recycled", async () => {
    // The concrete regression: without the window this is `live` and the workspace can never
    // be relaunched again by the monitor.
    const probeTree = vi.fn(() => ({ liveness: "alive" as const, pids: [100], reason: "pid 100 is alive" }));
    const liveness = await findLiveAgentTrees(
      [{ id: "ancient", pid: 100, endedAt: ago(7 * 24 * 3600_000) }],
      { probeTree, nowMs: now },
    );
    expect(probeTree).not.toHaveBeenCalled();
    expect(liveness.verdict).toBe("clear");
  });

  it("still catches the #968 survivor, which is recent by construction", async () => {
    const liveness = await findLiveAgentTrees(
      [
        { id: "ancient", pid: 55, endedAt: ago(7 * 24 * 3600_000) },
        { id: "62c6722d", pid: 100, endedAt: ago(16 * 60_000) },
      ],
      {
        probeTree: (pid) =>
          pid === 100
            ? { liveness: "alive", pids: [31344], reason: "survivor" }
            : { liveness: "alive", pids: [55], reason: "recycled pid, must never be reached" },
        nowMs: now,
      },
    );
    expect(liveness.verdict).toBe("live");
    expect(liveness.trees.map((t) => t.sessionId)).toEqual(["62c6722d"]);
  });
});

describe("liveAgentRefusalMessage — a refusal must be actionable (#968)", () => {
  it("names the surviving pids and the override", () => {
    const msg = liveAgentRefusalMessage({
      verdict: "live",
      trees: [{ sessionId: "62c6722d", pid: 100, pids: [31344, 31500], reason: "survivor" }],
      reason: "session 62c6722d (survivor)",
    });
    expect(msg).toContain("31344");
    expect(msg).toContain("31500");
    expect(msg).toContain("force");
    // It must say what the danger is, not just that it refused.
    expect(msg).toMatch(/two agents/i);
  });

  it("deduplicates pids shared across trees", () => {
    const msg = liveAgentRefusalMessage({
      verdict: "live",
      trees: [
        { sessionId: "a", pid: 1, pids: [31344], reason: "r" },
        { sessionId: "b", pid: 2, pids: [31344], reason: "r" },
      ],
      reason: "r",
    });
    expect(msg.match(/31344/g)).toHaveLength(1);
  });
});
