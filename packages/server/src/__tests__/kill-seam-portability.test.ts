import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

/**
 * #832 — plugin view servers and port squatters are killed on POSIX too.
 *
 * `plugin-views.service.ts` (4 sites) and `process-cleanup.ts` (3 named sites, plus the
 * POSIX dir sweep) reached for a kill that only existed on Windows. `plugin-views` called
 * the win32-only `taskkillTree` under a `process.platform === "win32"` guard with no POSIX
 * arm at all — so on Linux the stray sweep collected pids, cleared them, and killed nothing.
 * `process-cleanup` had the shape #828 fixed in the startup reapers: a win32 arm calling the
 * MOCKABLE `taskkillTree` and a POSIX arm calling `process.kill` directly, which means a test
 * on Linux asks the OS to signal a fabricated pid, gets ESRCH, and proves nothing.
 *
 * ## What these tests can and cannot prove
 *
 * They run on Windows. The POSIX arm of `killProcessTree` is UNREACHABLE here, so nothing
 * below is evidence that SIGKILL lands on a Linux box — that is CI's job (#834). What they do
 * prove is the property that makes the CI run meaningful: **every kill in both modules goes
 * through the one seam, with the arguments it needs, on whatever platform the suite runs on.**
 * The seam is mocked, so these assertions are identical on Windows and Linux — which is
 * precisely what was NOT true before, when the Windows suite was green while Linux killed
 * nothing.
 */

// The ONE kill seam. Mocking it (rather than `taskkillTree`) is the point: a site that still
// branched on `process.platform` would take an unmocked path on one of the two platforms and
// these assertions would fail there — which is how the defect is meant to surface next time.
const { killProcessTree, spawnShellCommand, listenerPidsForPort, listOsProcesses } = vi.hoisted(() => ({
  killProcessTree: vi.fn(async (_pid: number, _options?: unknown) => {}),
  spawnShellCommand: vi.fn(),
  listenerPidsForPort: vi.fn(async (_port: number) => [] as number[]),
  listOsProcesses: vi.fn(async () => [] as { pid: number; ppid: number; commandLine: string }[]),
}));

vi.mock("../services/process-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/process-exec.js")>();
  return {
    ...actual,
    killProcessTree,
    taskkillTree: vi.fn(async () => {}),
    spawnShellCommand,
    listenerPidsForPort,
    listOsProcesses,
    execCommand: vi.fn(async () => ({ stdout: "", stderr: "" })),
  };
});

// Silences the audit ring (it console.logs a line per event and appends to a file in $HOME)
// and takes the protected-pid policy out of the picture — this suite is about the seam.
vi.mock("../services/process-guard.js", () => ({
  auditProcessEvent: vi.fn(),
  guardProcessKill: vi.fn(() => true),
}));

// `startView` waits for a real health probe otherwise; the fake child never listens.
vi.mock("../services/plugin-view-probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/plugin-view-probe.js")>();
  return { ...actual, probeHealth: vi.fn(async () => true) };
});

import {
  createPluginViewsRuntime,
  stopAllPluginViews,
  stopAllPluginViewsAsync,
  stopPluginViews,
} from "../services/plugin-views.service.js";
import {
  killProcessesOnPorts,
  killDevServerSupervisorOnPorts,
} from "../services/process-cleanup.js";

/** A stand-in for the `cmd.exe`/`sh` wrapper `spawnShellCommand` returns. */
function fakeChild(pid: number): ChildProcess & { emitExit: (code: number | null) => void } {
  const child = new EventEmitter() as unknown as ChildProcess & { emitExit: (code: number | null) => void };
  Object.assign(child, {
    pid,
    exitCode: null as number | null,
    killed: false,
    stderr: new EventEmitter(),
    kill: vi.fn(() => {
      (child as { killed: boolean }).killed = true;
      return true;
    }),
    emitExit: (code: number | null) => {
      (child as { exitCode: number | null }).exitCode = code;
      child.emit("exit", code);
    },
  });
  return child;
}

const PLUGIN_ROW = "plugin-row-1";
const PROJECT = "project-1";

function makeRuntime() {
  return createPluginViewsRuntime({
    requirePlugin: async (id: string) => ({
      id,
      pluginId: "kill-seam-plugin",
      localPath: process.cwd(),
      manifest: {
        id: "kill-seam-plugin",
        name: "Kill Seam Plugin",
        views: [{ id: "panel", label: "Panel", kind: "iframe" as const, serve: { command: "node serve.mjs", cwd: "plugin" as const } }],
      },
    }),
    requireProject: async (id: string) => ({ id, repoPath: process.cwd(), name: "proj" }),
    resolveOutputRepoPath: async () => process.cwd(),
    listEnabledPlugins: async () => [],
    boardUrl: "http://localhost:13001",
  });
}

/** Start one view backed by `child`, leaving it tracked in the module-level map. */
async function startTrackedView(child: ChildProcess) {
  spawnShellCommand.mockReturnValueOnce(child);
  const runtime = makeRuntime();
  await runtime.startView({ pluginRowId: PLUGIN_ROW, viewId: "panel", projectId: PROJECT });
  return runtime;
}

describe("plugin view servers are killed through the one seam (#832)", () => {
  beforeEach(() => {
    killProcessTree.mockClear();
    killProcessTree.mockImplementation(async () => {});
    spawnShellCommand.mockReset();
  });

  afterEach(async () => {
    killProcessTree.mockImplementation(async () => {});
    await stopAllPluginViewsAsync();
    vi.restoreAllMocks();
  });

  it("stopView kills the tracked pid (killChildAsync)", async () => {
    const child = fakeChild(4101);
    const runtime = await startTrackedView(child);
    killProcessTree.mockClear();

    await runtime.stopView({ pluginRowId: PLUGIN_ROW, viewId: "panel", projectId: PROJECT });

    expect(killProcessTree).toHaveBeenCalledWith(4101);
  });

  it("stopAllPluginViews (sync shutdown path) kills the tracked pid (killChild)", async () => {
    const child = fakeChild(4102);
    await startTrackedView(child);
    killProcessTree.mockClear();

    expect(stopAllPluginViews()).toBe(1);

    expect(killProcessTree).toHaveBeenCalledWith(4102);
  });

  it("stopPluginViews (uninstall/disable path) kills the tracked pid", async () => {
    const child = fakeChild(4103);
    await startTrackedView(child);
    killProcessTree.mockClear();

    expect(stopPluginViews(PLUGIN_ROW, PROJECT)).toBe(1);

    expect(killProcessTree).toHaveBeenCalledWith(4103);
  });

  it("the wrapper's exit handler kills the tree of the pid it recorded", async () => {
    const child = fakeChild(4104);
    await startTrackedView(child);
    killProcessTree.mockClear();

    child.emitExit(0);

    expect(killProcessTree).toHaveBeenCalledWith(4104);
  });

  /**
   * The half that was DEAD on POSIX: the stray sweep was inside `if (win32)`, so on Linux the
   * pids were collected, cleared, and nothing was killed — exactly the orphan class #352 added
   * the set to remove. The map entry is gone here (the wrapper exited), so only the sweep can
   * reach this pid.
   */
  it("stopAllPluginViewsAsync sweeps strays whose map entry the exit handler already dropped", async () => {
    const child = fakeChild(4105);
    await startTrackedView(child);
    child.emitExit(0);
    killProcessTree.mockClear();

    await stopAllPluginViewsAsync();

    expect(killProcessTree).toHaveBeenCalledWith(4105);
  });

  it("logs a kill failure instead of swallowing it", async () => {
    const child = fakeChild(4106);
    const runtime = await startTrackedView(child);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    killProcessTree.mockRejectedValueOnce(
      Object.assign(new Error("spawn taskkill ENOENT"), { code: "ENOENT" }) as never,
    );

    await runtime.stopView({ pluginRowId: PLUGIN_ROW, viewId: "panel", projectId: PROJECT });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[plugins] failed to kill view server tree for PID 4106"));
  });

  it("stays quiet when the process was already gone", async () => {
    const child = fakeChild(4107);
    const runtime = await startTrackedView(child);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    killProcessTree.mockRejectedValueOnce(
      Object.assign(new Error("kill ESRCH"), { code: "ESRCH" }) as never,
    );

    await runtime.stopView({ pluginRowId: PLUGIN_ROW, viewId: "panel", projectId: PROJECT });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("port squatters are killed through the one seam (#832)", () => {
  beforeEach(() => {
    killProcessTree.mockClear();
    killProcessTree.mockImplementation(async () => {});
    listenerPidsForPort.mockReset();
    listOsProcesses.mockReset();
  });

  it("killProcessesOnPorts asks the seam, with SIGTERM preserved for POSIX", async () => {
    listenerPidsForPort.mockResolvedValue([5201]);

    expect(await killProcessesOnPorts([13001])).toBe(1);

    // The signal matters: the pre-#832 POSIX arm sent SIGTERM, and the seam's default is
    // SIGKILL — so an argument-free swap would have silently escalated a graceful stop.
    expect(killProcessTree).toHaveBeenCalledWith(5201, { timeout: 5000, signal: "SIGTERM" });
  });

  it("killDevServerSupervisorOnPorts asks the seam for the dev.mjs ancestor", async () => {
    listenerPidsForPort.mockResolvedValue([5301]);
    listOsProcesses.mockResolvedValue([
      { pid: 5301, ppid: 5300, commandLine: "node vite" },
      { pid: 5300, ppid: 1, commandLine: "node scripts/dev.mjs" },
    ]);

    expect(await killDevServerSupervisorOnPorts([13001])).toBe(1);

    expect(killProcessTree).toHaveBeenCalledWith(5300, { timeout: 5000, signal: "SIGTERM" });
  });
});
