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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerAgentRunner } from "../worker/worker-agent-runner.js";
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
