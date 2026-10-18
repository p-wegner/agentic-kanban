import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * #1488 — background (normal-lane) git spawns are rate-limited per second so a sweep over hundreds
 * of old workspaces cannot saturate the event loop with CreateProcess calls; request-path
 * (`interactive`) spawns are exempt. Same mock seam as git-exec-scheduler.test.ts.
 */
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(() => ""),
  spawn: vi.fn(() => ({})),
}));

import { execFile } from "node:child_process";
import { gitExec, __resetGitExecSchedulerForTests } from "../src/lib/git-exec.js";
import {
  callerFromStack,
  configureGitBackgroundSpawnBudget,
  drainGitSpawnCallers,
} from "../src/lib/git-spawn-governor.js";

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
let spawned = 0;
let callbacks: ExecCb[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  __resetGitExecSchedulerForTests();
  spawned = 0;
  callbacks = [];
  vi.mocked(execFile).mockReset().mockImplementation(((_c: string, _a: string[], _o: unknown, cb: ExecCb) => {
    spawned++;
    callbacks.push(cb);
    queueMicrotask(() => cb(null, "ok", ""));
    return { stdin: { end: vi.fn() }, once: vi.fn() };
  }) as never);
});

afterEach(() => {
  __resetGitExecSchedulerForTests();
  vi.useRealTimers();
});

describe("background spawn budget", () => {
  it("is unlimited by default", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => gitExec(["status", `--${i}`], { cwd: "/r" })));
    expect(spawned).toBe(20);
  });

  it("starts at most N normal-lane spawns per second and releases the rest as the window rolls", async () => {
    configureGitBackgroundSpawnBudget(3);
    const calls = Array.from({ length: 7 }, (_, i) => gitExec(["log", `-${i + 1}`], { cwd: "/r" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(spawned).toBe(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawned).toBe(6);
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawned).toBe(7);
    await Promise.all(calls);
  });

  it("keeps the process alive while spawns wait on the budget (#1507: an unref'd timer let the board exit mid-boot)", async () => {
    configureGitBackgroundSpawnBudget(1);
    const handles: Array<{ hasRef?: () => boolean }> = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const h = realSetTimeout(fn, ms) as unknown as { hasRef?: () => boolean };
      handles.push(h);
      return h;
    }) as never);
    const calls = [gitExec(["log", "-1"], { cwd: "/r" }), gitExec(["log", "-2"], { cwd: "/r" })];
    expect(handles.length).toBeGreaterThan(0);
    for (const h of handles) expect(h.hasRef?.() ?? true).toBe(true);
    spy.mockRestore();
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(calls);
  });

  it("never throttles interactive spawns, even with the background budget exhausted", async () => {
    configureGitBackgroundSpawnBudget(1);
    void gitExec(["log", "-1"], { cwd: "/r" });
    void gitExec(["log", "-2"], { cwd: "/r" }); // queued behind the budget
    const interactive = gitExec(["log", "-3"], { cwd: "/r", priority: "interactive" });
    await vi.advanceTimersByTimeAsync(0);
    expect(spawned).toBe(2); // first background + the interactive one
    await interactive;
  });
});

describe("caller attribution", () => {
  it("counts which call site queued the spawns and resets on drain", async () => {
    drainGitSpawnCallers();
    await Promise.all([gitExec(["status", "-a"], { cwd: "/r" }), gitExec(["status", "-b"], { cwd: "/r" })]);
    const top = drainGitSpawnCallers();
    expect(top).toHaveLength(1);
    expect(top[0].count).toBe(2);
    expect(top[0].caller).toContain("git-exec-background-budget.test.ts");
    expect(top[0].caller).toContain("git:status");
    expect(drainGitSpawnCallers()).toEqual([]);
  });

  it("skips git plumbing frames when naming the caller", () => {
    const stack = [
      "Error",
      "    at scheduleSpawn (C:/x/packages/shared/src/lib/git-exec.ts:225:3)",
      "    at getCommitCountAhead (C:/x/packages/shared/src/lib/git-service/history.ts:30:9)",
      "    at sweep (C:/x/packages/server/src/startup/some-reconciler.ts:88:14)",
    ].join("\n");
    expect(callerFromStack(stack)).toBe("startup/some-reconciler.ts:88");
  });

  it("skips plumbing by function name when every frame is the same bundle file (#1614)", () => {
    const stack = [
      "Error",
      "    at noteGitSpawnCaller (file:///x/dist/cli/index.js:5978:20)",
      "    at gitExec (file:///x/dist/cli/index.js:6100:3)",
      "    at getDiffShortstat (file:///x/dist/cli/index.js:7001:9)",
    ].join("\n");
    expect(callerFromStack(stack)).toBe("cli/index.js:7001 getDiffShortstat");
  });
});
