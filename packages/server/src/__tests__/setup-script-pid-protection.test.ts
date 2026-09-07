/**
 * #1059 — the board must never reap a process it is itself awaiting.
 *
 * The resource sweeper killed two in-flight pre-merge verify trees on 2026-09-07 (workspace
 * 500c9c62), each within a second of a sweep tick, because a verify run in a worktree holds no
 * listening port and is tied to no live agent session — so nothing in `protectedPids()` knew it
 * existed. These cases pin the seam that closes it.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { runSetupScript, setSetupProcessObserver } from "@agentic-kanban/shared/lib/setup-script";
import {
  protectedPids,
  registerProtectedPid,
  releaseProtectedPid,
  clearRuntimeProtectedPids,
  runtimeProtectedPidList,
} from "../services/process-guard.js";
import { classifyStaleDevProcessTrees } from "../services/stale-dev-processes.js";

afterEach(() => {
  setSetupProcessObserver(null);
  clearRuntimeProtectedPids();
});

describe("runtime protected pids (#1059)", () => {
  it("registers a pid for the lifetime of the call and releases it afterwards", async () => {
    const seen: Array<{ kind: string; pid: number }> = [];
    let pidDuringRun: number | undefined;
    setSetupProcessObserver({
      onSpawn: (pid) => {
        seen.push({ kind: "spawn", pid });
        registerProtectedPid(pid);
        pidDuringRun = pid;
      },
      onSettle: (pid) => {
        seen.push({ kind: "settle", pid });
        // Asserted BEFORE release: this is the window the sweeper ticks in.
        expect(protectedPids().has(pid)).toBe(true);
        releaseProtectedPid(pid);
      },
    });

    const result = await runSetupScript(process.cwd(), "node -e \"console.log('ok')\"", { timeoutMs: 60_000 });

    expect(result.exitCode).toBe(0);
    expect(seen.map((s) => s.kind)).toEqual(["spawn", "settle"]);
    expect(pidDuringRun).toBeGreaterThan(0);
    // Released, so a reused pid does not inherit a permanent exemption.
    expect(runtimeProtectedPidList()).not.toContain(pidDuringRun);
  });

  it("releases the pid even when the run is killed by its timeout", async () => {
    const settled: number[] = [];
    setSetupProcessObserver({
      onSpawn: (pid) => registerProtectedPid(pid),
      onSettle: (pid) => {
        settled.push(pid);
        releaseProtectedPid(pid);
      },
    });

    // A no-progress/timeout kill must go through `cleanup()` like any other settle path,
    // or the pid leaks a protection that outlives the process holding it.
    const result = await runSetupScript(process.cwd(), "node -e \"setTimeout(()=>{}, 60000)\"", { timeoutMs: 1500 });

    expect(result.timedOut).toBe(true);
    expect(settled).toHaveLength(1);
    expect(runtimeProtectedPidList()).toEqual([]);
  });

  it("reference-counts, so one run finishing cannot strip another's protection", () => {
    registerProtectedPid(4242);
    registerProtectedPid(4242);
    releaseProtectedPid(4242);
    expect(protectedPids().has(4242)).toBe(true);
    releaseProtectedPid(4242);
    expect(protectedPids().has(4242)).toBe(false);
  });

  it("ignores an invalid pid rather than protecting a bogus entry", () => {
    registerProtectedPid(0);
    registerProtectedPid(-1);
    expect(runtimeProtectedPidList()).toEqual([]);
  });

  it("survives an observer that throws — it must never fail the run it protects", async () => {
    setSetupProcessObserver({
      onSpawn: () => { throw new Error("observer blew up"); },
      onSettle: () => { throw new Error("observer blew up"); },
    });
    const result = await runSetupScript(process.cwd(), "node -e \"console.log('ok')\"", { timeoutMs: 60_000 });
    expect(result.exitCode).toBe(0);
  });
});

describe("the sweeper keeps a registered verify tree (#1059)", () => {
  /**
   * The exact shape that was reaped. Note WHY the classifier even considers it: the project's
   * verify script is `pnpm check:arch && pnpm typecheck && pnpm test:mine`, so the shell's
   * command line contains `pnpm test:mine` and matches `isTestTreeProcess` — the #172 heuristic
   * added to reap LEAKED vitest workers. It then has no listener and no live agent session, and
   * falls straight into `stale-dev-tree-no-listeners`. The heuristic that cleans up after a test
   * run is the one that kills a test run in progress.
   */
  const verifyTree = (pid: number) => [
    { pid, ppid: 1, name: "cmd.exe", commandLine: "cmd.exe /d /s /c pnpm check:arch && pnpm typecheck && pnpm test:mine", executablePath: "cmd.exe" },
    { pid: pid + 1, ppid: pid, name: "node.exe", commandLine: "node C:/projects/andrena/.worktrees/agentic-kanban/ak-1048/node_modules/tsc", executablePath: "node.exe" },
  ];

  const input = (protectedPidSet: Set<number>) => ({
    processes: verifyTree(9001),
    listeners: [],
    activeWorkspaces: [],
    cleanupScopePaths: ["c:/projects/andrena/.worktrees/agentic-kanban/ak-1048"],
    protectedPorts: new Set<number>(),
    protectedPidSet,
    now: new Date("2026-09-07T20:19:52Z"),
  });

  it("REAPS the tree when nothing protects it — the pre-fix behaviour", () => {
    const snapshot = classifyStaleDevProcessTrees(input(new Set()));
    expect(snapshot.cleaned.map((d) => d.reason)).toContain("stale-dev-tree-no-listeners");
    expect(snapshot.kept).toHaveLength(0);
  });

  it("KEEPS the tree once the spawn pid is registered", () => {
    clearRuntimeProtectedPids();
    registerProtectedPid(9001);
    const snapshot = classifyStaleDevProcessTrees(input(protectedPids()));
    expect(snapshot.cleaned).toHaveLength(0);
    expect(snapshot.kept.map((d) => d.reason).join(",")).toContain("protected-pid");
  });
});
