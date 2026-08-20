import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * #398 — the git-exec adapter is the process-wide spawn SCHEDULER, not just the spawn
 * site. These lock its three behaviours:
 *  1. a FIFO semaphore of GIT_SPAWN_SLOTS over all buffered async spawns, with an
 *     `interactive` priority lane that jumps the normal queue;
 *  2. identical concurrent READ-ONLY calls collapse to one child, and identical
 *     back-to-back read-only calls within the memo TTL share one result;
 *  3. mutating commands are NEVER deduped (each call spawns its own child).
 *
 * Uses the same seam as git-exec-defaults.test.ts: mock node:child_process and count /
 * control the execFile invocations directly.
 */
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(() => ""),
  spawn: vi.fn(() => ({})),
}));

import { execFile } from "node:child_process";
import {
  gitExec,
  runWithGitPriority,
  GIT_SPAWN_SLOTS,
  GIT_DEDUPE_MEMO_TTL_MS,
  __resetGitExecSchedulerForTests,
} from "../src/lib/git-exec.js";

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
type Pending = { args: string[]; cb: ExecCb };

/** Children spawned by the mock that have not been completed yet, in spawn order. */
let pending: Pending[] = [];
/** Total children ever spawned in the current test. */
let spawned = 0;

function completeNext(stdout = "out"): void {
  const child = pending.shift();
  if (!child) throw new Error("no pending child to complete");
  child.cb(null, stdout, "");
}

/** Let promise continuations (queue hand-off, dedupe resolution) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  __resetGitExecSchedulerForTests();
  pending = [];
  spawned = 0;
  vi.mocked(execFile).mockReset().mockImplementation(((
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: ExecCb,
  ) => {
    spawned++;
    pending.push({ args, cb });
    return { stdin: { end: vi.fn() }, once: vi.fn() };
  }) as never);
});

describe("read-only dedupe", () => {
  it("collapses concurrent identical read-only calls to ONE spawn, all callers get the result", async () => {
    const calls = Array.from({ length: 5 }, () => gitExec(["rev-parse", "HEAD"], { cwd: "/repo" }));
    expect(spawned).toBe(1);
    completeNext("abc123\n");
    const results = await Promise.all(calls);
    for (const r of results) {
      expect(r.stdout).toBe("abc123\n");
      expect(r.code).toBe(0);
    }
    expect(spawned).toBe(1);
  });

  it("serves an identical back-to-back read-only call from the short-TTL memo without a new spawn", async () => {
    expect(GIT_DEDUPE_MEMO_TTL_MS).toBeLessThanOrEqual(2000); // "very short" per the ticket
    const first = gitExec(["status", "--porcelain"], { cwd: "/repo" });
    completeNext("M file.ts\n");
    await first;
    const second = await gitExec(["status", "--porcelain"], { cwd: "/repo" });
    expect(second.stdout).toBe("M file.ts\n");
    expect(spawned).toBe(1);
  });

  it("does NOT dedupe calls that differ in cwd or argv", async () => {
    void gitExec(["rev-parse", "HEAD"], { cwd: "/repo-a" });
    void gitExec(["rev-parse", "HEAD"], { cwd: "/repo-b" });
    void gitExec(["rev-parse", "HEAD~1"], { cwd: "/repo-a" });
    expect(spawned).toBe(3);
  });

  it("does NOT dedupe calls carrying env or input, even for read-only subcommands", async () => {
    void gitExec(["status"], { cwd: "/repo", env: { GIT_INDEX_FILE: "/tmp/idx" } });
    void gitExec(["status"], { cwd: "/repo", env: { GIT_INDEX_FILE: "/tmp/idx" } });
    void gitExec(["cat-file", "--batch"], { cwd: "/repo", input: "HEAD\n" });
    void gitExec(["cat-file", "--batch"], { cwd: "/repo", input: "HEAD\n" });
    expect(spawned).toBe(4);
  });

  it("a mutating command is NEVER deduped — identical concurrent commits each spawn", async () => {
    void gitExec(["commit", "-m", "x"], { cwd: "/repo" });
    void gitExec(["commit", "-m", "x"], { cwd: "/repo" });
    void gitExec(["merge", "feature/x"], { cwd: "/repo" });
    void gitExec(["merge", "feature/x"], { cwd: "/repo" });
    expect(spawned).toBe(4);
  });

  it("a mutating command in the same cwd invalidates the memo, so the next read re-spawns", async () => {
    const read1 = gitExec(["rev-parse", "HEAD"], { cwd: "/repo" });
    completeNext("old-sha\n");
    await read1;
    expect(spawned).toBe(1);

    const commit = gitExec(["commit", "-m", "advance"], { cwd: "/repo" });
    completeNext("");
    await commit;

    const read2 = gitExec(["rev-parse", "HEAD"], { cwd: "/repo" });
    expect(spawned).toBe(3); // memo did not serve the stale pre-commit sha
    completeNext("new-sha\n");
    expect((await read2).stdout).toBe("new-sha\n");
  });
});

describe("process-wide spawn semaphore", () => {
  it("never has more than GIT_SPAWN_SLOTS children in flight, and drains FIFO", async () => {
    const total = GIT_SPAWN_SLOTS + 12;
    // Distinct mutating commands so neither dedupe layer merges them.
    const calls = Array.from({ length: total }, (_, i) => gitExec(["fetch", `remote-${i}`], { cwd: "/repo" }));
    expect(spawned).toBe(GIT_SPAWN_SLOTS);
    expect(pending.length).toBe(GIT_SPAWN_SLOTS);

    completeNext();
    await flush();
    expect(spawned).toBe(GIT_SPAWN_SLOTS + 1); // exactly one slot handed on
    // FIFO: the first queued call (remote-8) is the one that spawned next.
    expect(pending[pending.length - 1].args).toEqual(["fetch", `remote-${GIT_SPAWN_SLOTS}`]);

    while (pending.length > 0) {
      completeNext();
      await flush();
      expect(pending.length).toBeLessThanOrEqual(GIT_SPAWN_SLOTS);
    }
    expect(spawned).toBe(total);
    await Promise.all(calls);
  });

  it("an interactive call queued behind a full normal queue runs before the normal backlog", async () => {
    // Fill all slots.
    for (let i = 0; i < GIT_SPAWN_SLOTS; i++) void gitExec(["fetch", `busy-${i}`], { cwd: "/repo" });
    // Queue normal background work, then one interactive request-path call.
    for (let i = 0; i < 4; i++) void gitExec(["fetch", `bg-${i}`], { cwd: "/repo" });
    void gitExec(["fetch", "user-request"], { cwd: "/repo", priority: "interactive" });
    expect(spawned).toBe(GIT_SPAWN_SLOTS);

    completeNext();
    await flush();
    // The freed slot went to the interactive call, jumping the 4 queued normal calls.
    expect(pending[pending.length - 1].args).toEqual(["fetch", "user-request"]);

    // The normal lane then drains FIFO.
    completeNext();
    await flush();
    expect(pending[pending.length - 1].args).toEqual(["fetch", "bg-0"]);
  });

  // #398 follow-up (G8) — the interactive lane was dead code because no production call
  // site passed `priority: "interactive"`. HTTP request paths now get it AMBIENTLY: a
  // Hono middleware wraps each /api request in `runWithGitPriority("interactive", next)`
  // and gitExec reads the AsyncLocalStorage context when no explicit priority is passed.
  describe("ambient priority context (HTTP middleware seam)", () => {
    it("a call inside runWithGitPriority('interactive') jumps the normal backlog WITHOUT an explicit option", async () => {
      for (let i = 0; i < GIT_SPAWN_SLOTS; i++) void gitExec(["fetch", `busy-${i}`], { cwd: "/repo" });
      for (let i = 0; i < 4; i++) void gitExec(["fetch", `bg-${i}`], { cwd: "/repo" });
      // The middleware seam: no per-call option anywhere below this scope.
      runWithGitPriority("interactive", () => {
        void gitExec(["fetch", "http-request"], { cwd: "/repo" });
      });
      expect(spawned).toBe(GIT_SPAWN_SLOTS);

      completeNext();
      await flush();
      // The freed slot went to the request-path call, jumping the 4 queued normal calls.
      expect(pending[pending.length - 1].args).toEqual(["fetch", "http-request"]);

      // A background call OUTSIDE the scope stayed in the normal lane and drains FIFO.
      completeNext();
      await flush();
      expect(pending[pending.length - 1].args).toEqual(["fetch", "bg-0"]);
    });

    it("the ambient priority survives awaits (AsyncLocalStorage, not a sync flag)", async () => {
      for (let i = 0; i < GIT_SPAWN_SLOTS; i++) void gitExec(["fetch", `busy-${i}`], { cwd: "/repo" });
      for (let i = 0; i < 3; i++) void gitExec(["fetch", `bg-${i}`], { cwd: "/repo" });
      await runWithGitPriority("interactive", async () => {
        // A handler always awaits (DB reads, other git calls) before spawning more git.
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        void gitExec(["fetch", "after-awaits"], { cwd: "/repo" });
      });

      completeNext();
      await flush();
      expect(pending[pending.length - 1].args).toEqual(["fetch", "after-awaits"]);
    });

    it("an explicit per-call priority wins over the ambient context", async () => {
      for (let i = 0; i < GIT_SPAWN_SLOTS; i++) void gitExec(["fetch", `busy-${i}`], { cwd: "/repo" });
      void gitExec(["fetch", "bg-0"], { cwd: "/repo" });
      runWithGitPriority("interactive", () => {
        // Explicitly demoted despite the interactive scope (e.g. a fire-and-forget
        // background sweep a handler deliberately marks as non-urgent).
        void gitExec(["fetch", "demoted"], { cwd: "/repo", priority: "normal" });
      });

      completeNext();
      await flush();
      // FIFO in the normal lane: bg-0 was queued first, "demoted" did not jump it.
      expect(pending[pending.length - 1].args).toEqual(["fetch", "bg-0"]);
      completeNext();
      await flush();
      expect(pending[pending.length - 1].args).toEqual(["fetch", "demoted"]);
    });
  });

  it("deduped concurrent calls consume only one slot", async () => {
    // 5 identical read-only calls + fill the rest of the slots with distinct work.
    const reads = Array.from({ length: 5 }, () => gitExec(["log", "-1"], { cwd: "/repo" }));
    for (let i = 0; i < GIT_SPAWN_SLOTS - 1; i++) void gitExec(["fetch", `fill-${i}`], { cwd: "/repo" });
    // 1 (shared read) + 7 fills = 8 spawns: the reads did not exhaust the semaphore.
    expect(spawned).toBe(GIT_SPAWN_SLOTS);
    completeNext("log-line\n");
    for (const r of await Promise.all(reads)) expect(r.stdout).toBe("log-line\n");
  });
});
