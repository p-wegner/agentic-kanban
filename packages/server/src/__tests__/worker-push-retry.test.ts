// #750 item 1 (with #775 item 2) — a fleet worker that finishes and cannot push has
// produced work that exists ONLY in its own checkout.
//
// The old path pushed exactly once, and on failure `git worktree remove --force`d the
// checkout anyway: the commits survived solely on the `kanban/<sessionId>` branch in the
// worker's cache clone, which nothing on either machine enumerates. A transient failure
// (the board's fleet port bouncing, a link that dropped for ten seconds, the 401 a board
// restart produces per #775) therefore cost a whole agent run.
//
// Three properties are pinned here, each of which the single-shot version fails:
//   1. A transient failure is RETRIED with backoff, and a run that eventually pushes is
//      reported as the success it is (exit code not downgraded).
//   2. When every attempt fails the checkout is KEPT and its path is reported, so the work
//      is recoverable by hand instead of being deleted with the worktree.
//   3. A retained result is retried again on the daemon's next reconnect, which is the
//      only thing that can save a push that failed because the board was gone.
//
// The push is stubbed for the same reason #754's drain tests stub it: a real `git push`
// cannot be made to fail once and then succeed on demand.

import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerAgentRunner } from "../worker/worker-agent-runner.js";
import { loadUndelivered, undeliveredStateFile, upsertUndelivered } from "../worker/worker-undelivered.js";
import type {
  WorkerLaunchSpec,
  WorkerRepoTransport,
  WorkerToBoardMessage,
} from "@agentic-kanban/shared/lib/worker-protocol";

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined),
) as Record<string, string>;

function nodeSpec(script: string, overrides?: Partial<WorkerLaunchSpec>): WorkerLaunchSpec {
  return {
    command: process.execPath,
    args: ["-e", script],
    env: cleanEnv,
    cwd: tmpdir(),
    stdinPrompt: "",
    hangTimeoutMs: 0,
    ...overrides,
  };
}

const fakeRepo = (branch: string): WorkerRepoTransport => ({
  projectId: "p1",
  gitPort: 1,
  gitToken: "t",
  branch,
  baseBranch: "master",
  incomingRef: `refs/kanban/incoming/${branch}`,
});

// A REAL directory: the runner spawns the agent with `cwd` set to the checkout, and a
// nonexistent cwd fails the spawn before the push under test is ever reached.
const CHECKOUT = mkdtempSync(join(tmpdir(), "ak-worker-checkout-750-"));

/**
 * Every runner in this file gets its own throwaway work root: since #871 a retained
 * result is PERSISTED under the work root, and the default is the machine's real
 * `~/.agentic-kanban/worker` — a test must never write fake undelivered entries there
 * (a real daemon would restore and report them).
 */
const freshWorkRoot = () => mkdtempSync(join(tmpdir(), "ak-worker-root-"));

/**
 * A git transport that does no git: `push` is scripted per attempt, and `cleanup` is
 * COUNTED because "was the checkout destroyed" is the property under test.
 */
function scriptedRepoOps(pushOutcomes: Array<Error | null>) {
  const state = { pushes: 0, cleanups: 0 };
  return {
    state,
    ops: {
      provision: async () => ({ cwd: CHECKOUT, cacheDir: tmpdir() }),
      push: async () => {
        const outcome = pushOutcomes[state.pushes] ?? null;
        state.pushes += 1;
        if (outcome) throw outcome;
      },
      cleanup: async () => { state.cleanups += 1; },
    },
  };
}

function collector() {
  const messages: WorkerToBoardMessage[] = [];
  const push = (m: WorkerToBoardMessage) => messages.push(m);
  const exitOf = (sessionId: string) =>
    messages.flatMap((m) => (m.type === "event" && m.event.sessionId === sessionId ? [m.event] : []))
      .find((e) => e.type === "exit");
  const stderrOf = (sessionId: string) =>
    messages
      .flatMap((m) => (m.type === "event" && m.event.sessionId === sessionId && m.event.type === "stderr" ? [m.event.data ?? ""] : []))
      .join("\n");
  return { messages, push, exitOf, stderrOf };
}

describe("#750 — a worker retries a failed result push instead of losing the run", () => {
  it("retries a transient push failure and still reports a clean exit", async () => {
    const { push: send, exitOf, stderrOf } = collector();
    const { state, ops } = scriptedRepoOps([new Error("fatal: could not read from remote")]);
    const runner = createWorkerAgentRunner(send, {
      boardUrl: "http://board",
      repoOps: ops,
      pushRetryDelaysMs: [1, 1],
      workRoot: freshWorkRoot(),
    });

    runner.assignWithRepo("s-transient", nodeSpec("process.exit(0)"), fakeRepo("feature/ak-750"));
    await vi.waitFor(() => expect(exitOf("s-transient")).toBeTruthy(), { timeout: 20000 });

    expect(state.pushes).toBe(2);
    // The whole point: a run whose work DID arrive must not be recorded as a failure.
    expect(exitOf("s-transient")!.exitCode).toBe(0);
    expect(stderrOf("s-transient")).toContain("Retrying in");
    // Pushed, so the checkout is disposable again.
    expect(state.cleanups).toBe(1);
    expect(runner.unpushedResults()).toEqual([]);
  }, 40000);

  it("keeps the checkout and names it when every attempt fails (#775 item 2)", async () => {
    const { push: send, exitOf, stderrOf } = collector();
    const { state, ops } = scriptedRepoOps([
      new Error("401 Unauthorized"),
      new Error("401 Unauthorized"),
      new Error("401 Unauthorized"),
    ]);
    const runner = createWorkerAgentRunner(send, {
      boardUrl: "http://board",
      repoOps: ops,
      pushRetryDelaysMs: [1, 1],
      workRoot: freshWorkRoot(),
    });

    runner.assignWithRepo("s-lost", nodeSpec("process.exit(0)"), fakeRepo("feature/ak-751"));
    await vi.waitFor(() => expect(exitOf("s-lost")).toBeTruthy(), { timeout: 20000 });

    expect(state.pushes).toBe(3);
    expect(exitOf("s-lost")!.exitCode).toBe(1);
    // The old behaviour: force-remove the worktree, leaving the commits only on the
    // never-enumerated cache branch. The work must stay where a human can reach it.
    expect(state.cleanups).toBe(0);
    const retained = runner.unpushedResults();
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      sessionId: "s-lost",
      checkoutPath: CHECKOUT,
      localBranch: "kanban/s-lost",
      attempts: 3,
    });
    // Reported into the session's own transcript — the board cannot see the worker's disk.
    expect(stderrOf("s-lost")).toContain(CHECKOUT);
    expect(stderrOf("s-lost")).toContain("kanban/s-lost");
  }, 40000);

  it("pushes a retained result on the next reconnect", async () => {
    const { push: send, exitOf } = collector();
    const { state, ops } = scriptedRepoOps([new Error("ECONNREFUSED"), new Error("ECONNREFUSED"), null]);
    const runner = createWorkerAgentRunner(send, {
      boardUrl: "http://board",
      repoOps: ops,
      pushRetryDelaysMs: [1],
      workRoot: freshWorkRoot(),
    });

    runner.assignWithRepo("s-late", nodeSpec("process.exit(0)"), fakeRepo("feature/ak-752"));
    await vi.waitFor(() => expect(exitOf("s-late")).toBeTruthy(), { timeout: 20000 });
    expect(runner.unpushedResults()).toHaveLength(1);

    // What the daemon does when its socket comes back: the board was unreachable, which
    // is exactly the case a bounded in-run backoff cannot cover.
    const outcome = await runner.retryPendingPushes();
    expect(outcome).toEqual({ pushed: ["s-late"], stillPending: [] });
    expect(runner.unpushedResults()).toEqual([]);
    expect(state.cleanups).toBe(1);
  }, 40000);

  it("does not sit in a backoff sleep while a shutdown is draining", async () => {
    const { push: send } = collector();
    // Fails forever: without the suspend, the drain would wait out the whole delay list.
    const { state, ops } = scriptedRepoOps(Array.from({ length: 10 }, () => new Error("nope")));
    const runner = createWorkerAgentRunner(send, {
      boardUrl: "http://board",
      repoOps: ops,
      pushRetryDelaysMs: [60000, 60000, 60000],
      workRoot: freshWorkRoot(),
    });

    runner.assignWithRepo("s-drain", nodeSpec("process.exit(0)"), fakeRepo("feature/ak-753"));
    await vi.waitFor(() => expect(runner.pendingPushCount()).toBe(1), { timeout: 20000 });

    // A 60 s backoff must not turn a bounded drain into a timeout: the current attempt
    // finishes, the remaining retries are dropped, and the result is retained instead.
    expect(await runner.drainPushes(5000)).toEqual({ completed: 1, abandoned: 0 });
    expect(state.pushes).toBe(1);
    expect(runner.unpushedResults()).toHaveLength(1);
  }, 40000);
});

describe("#870 — an exhausted or misbehaving push path cannot kill the daemon", () => {
  it("still emits the exit and retains the result when the SEND callback throws", async () => {
    // The observed failure: "push failed (attempt 1)" then the daemon died — a throw out
    // of the detached push flow is an unhandled rejection, i.e. process death without the
    // CLI's guards. The send seam is the one collaborator the runner does not own, so it
    // is the one made hostile here.
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    const onUnhandled = (reason: unknown) => uncaught.push(reason);
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);
    try {
      const exits: Array<number | null> = [];
      const hostileSend = (m: WorkerToBoardMessage) => {
        if (m.type === "event" && m.event.type === "exit") {
          exits.push(m.event.exitCode ?? null);
          return;
        }
        throw new Error("socket exploded mid-send");
      };
      const { ops } = scriptedRepoOps([new Error("connect timeout"), new Error("connect timeout")]);
      const workRoot = mkdtempSync(join(tmpdir(), "ak-worker-870-"));
      const runner = createWorkerAgentRunner(hostileSend, {
        boardUrl: "http://board",
        repoOps: ops,
        pushRetryDelaysMs: [1],
        workRoot,
      });
      runner.assignWithRepo("s-hostile", nodeSpec("process.exit(0)"), fakeRepo("feature/ak-870"));
      await vi.waitFor(() => expect(exits).toHaveLength(1), { timeout: 20000 });
      // Failure downgraded, result retained, and — the point — nothing escaped.
      expect(exits[0]).toBe(1);
      expect(runner.unpushedResults()).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 100));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
    }
  }, 40000);

  it("retries with bounded backoff: the default list allows five attempts over ~2 minutes", async () => {
    // Pinned as data rather than by waiting it out: the shape #870 asks for is 3–5
    // attempts spread over about two minutes, so a single 21 s connect timeout (the
    // observed failure) cannot exhaust the policy in one go.
    const { DEFAULT_PUSH_RETRY_DELAYS_MS } = await import("../worker/worker-agent-runner.js");
    expect(DEFAULT_PUSH_RETRY_DELAYS_MS.length + 1).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_PUSH_RETRY_DELAYS_MS.length + 1).toBeLessThanOrEqual(5);
    const total = DEFAULT_PUSH_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(60_000);
    expect(total).toBeLessThanOrEqual(3 * 60_000);
  });
});

describe("#871 — a completed-but-undelivered result survives a daemon restart", () => {
  it("persists the retained entry (token-free) and clears it once delivered", async () => {
    const { push: send, exitOf } = collector();
    const { ops } = scriptedRepoOps([new Error("ECONNREFUSED"), new Error("ECONNREFUSED"), null]);
    const workRoot = mkdtempSync(join(tmpdir(), "ak-worker-871-"));
    const runner = createWorkerAgentRunner(send, {
      boardUrl: "http://board",
      repoOps: ops,
      pushRetryDelaysMs: [1],
      workRoot,
    });

    runner.assignWithRepo("s-persist", nodeSpec("process.exit(0)"), fakeRepo("feature/ak-871"));
    await vi.waitFor(() => expect(exitOf("s-persist")).toBeTruthy(), { timeout: 20000 });

    // On disk, and WITHOUT the credential: the token is per-assignment and must never
    // land in a file that outlives it.
    const persisted = loadUndelivered(workRoot);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      sessionId: "s-persist",
      branch: "feature/ak-871",
      incomingRef: "refs/kanban/incoming/feature/ak-871",
      checkoutPath: CHECKOUT,
      attempts: 2,
    });
    expect(JSON.stringify(persisted[0])).not.toContain("gitToken");

    // Delivered on reconnect -> the persisted entry is cleared with it.
    const outcome = await runner.retryPendingPushes();
    expect(outcome.pushed).toEqual(["s-persist"]);
    expect(loadUndelivered(workRoot)).toEqual([]);
  }, 40000);

  it("a fresh runner restores the persisted entry and retries it on reconnect", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "ak-worker-871-restore-"));
    // What the PREVIOUS daemon left behind before it died.
    upsertUndelivered(workRoot, {
      sessionId: "s-restored",
      branch: "feature/ak-871b",
      baseBranch: "master",
      incomingRef: "refs/kanban/incoming/feature/ak-871b",
      checkoutPath: CHECKOUT,
      cacheDir: tmpdir(),
      projectId: "p1",
      gitPort: 1,
      attempts: 6,
      lastError: "connect timeout",
      recordedAt: new Date().toISOString(),
    });
    expect(existsSync(undeliveredStateFile(workRoot))).toBe(true);

    const { push: send } = collector();
    const { state, ops } = scriptedRepoOps([new Error("401 Unauthorized")]);
    const runner = createWorkerAgentRunner(send, { boardUrl: "http://board", repoOps: ops, workRoot });

    // Restored across the restart — this is the entry the old in-memory map lost.
    expect(runner.unpushedResults()).toMatchObject([
      { sessionId: "s-restored", checkoutPath: CHECKOUT, incomingRef: "refs/kanban/incoming/feature/ak-871b" },
    ]);

    // The reconnect retry runs (with no credential it fails against a token-authed
    // transport) and the entry SURVIVES, with its attempt count kept honest on disk —
    // this is what the daemon then reports to the board as `undelivered_result`.
    const outcome = await runner.retryPendingPushes();
    expect(state.pushes).toBe(1);
    expect(outcome.pushed).toEqual([]);
    expect(outcome.stillPending).toEqual(["s-restored"]);
    expect(loadUndelivered(workRoot)[0]).toMatchObject({ sessionId: "s-restored", attempts: 7 });
  }, 40000);
});
