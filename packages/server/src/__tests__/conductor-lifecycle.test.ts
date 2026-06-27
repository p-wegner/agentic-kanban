// @covers monitor-orchestration.conductor.lifecycle [state-transition, error, regression]
//
// The out-of-process Conductor control (conductor-control.service.ts):
//   - start is a NO-OP if a loop is already alive (never spawn a second driver →
//     would double-drive the board), and
//   - stop tree-kills by the RECORDED PID plus a PowerShell backstop scoped to
//     board-monitor.loop.sh (must not over-kill a sibling / unrelated bash).
//
// Deterministic seam: there is no constructor-injection port in the product code, so
// we inject a fake spawn/kill PORT by mocking `child_process` (the same pattern the
// rest of packages/server uses, e.g. agent.service.test.ts). Liveness is driven via
// the real on-disk loop.log / loop.stopped files that readOrchestratorStatus reads —
// no process is ever actually spawned or killed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// --- the injected spawn/kill PORT ---------------------------------------------------
// conductor-control.service.ts imports from the bare specifier "child_process".
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => ({ pid: 4321, unref: vi.fn() })),
    execFile: vi.fn((_file: string, _args: string[], cb?: (e: unknown) => void) => {
      if (typeof cb === "function") cb(null);
      return { pid: 0 };
    }),
  };
});

import { spawn, execFile } from "child_process";
import { startConductor, stopConductor } from "../services/conductor-control.service.js";
import { readOrchestratorStatus } from "../services/orchestrator-monitor.service.js";

const spawnMock = vi.mocked(spawn);
const execFileMock = vi.mocked(execFile);

describe("conductor lifecycle (start no-op-if-alive, stop kills recorded PID)", () => {
  let repo: string;
  let dir: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "conductor-life-"));
    dir = join(repo, "scripts", "board-monitor");
    mkdirSync(dir, { recursive: true });
    // A repo "ships a loop" iff scripts/board-monitor/loop.sh exists (conductorAvailable).
    writeFileSync(join(dir, "loop.sh"), "#!/usr/bin/env bash\n", "utf8");
    spawnMock.mockClear();
    execFileMock.mockClear();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function writeFreshLog() {
    const p = join(dir, "loop.log");
    writeFileSync(p, "[2026-01-01T00:00:00+00:00] --- iteration 1 START ---\n", "utf8");
    const now = new Date();
    utimesSync(p, now, now);
  }

  it("start is a NO-OP when a Conductor loop is already alive (never spawns a second driver)", () => {
    // Arrange: a fresh loop.log and no stop-marker => readOrchestratorStatus reports alive.
    writeFreshLog();
    expect(readOrchestratorStatus(repo).alive).toBe(true);

    // Act
    const result = startConductor(repo);

    // Assert: refused without spawning anything.
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already running/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("start DOES spawn exactly one loop when none is alive (mutation contrast for the alive guard)", () => {
    // Arrange: loop.sh exists but no loop.log => not alive.
    expect(readOrchestratorStatus(repo).alive).toBe(false);

    // Act
    const result = startConductor(repo);

    // Assert: spawned once, recorded PID returned & persisted.
    expect(result.ok).toBe(true);
    expect(result.pid).toBe(4321);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [file, args] = spawnMock.mock.calls[0];
    expect(file).toBe("bash");
    expect(args).toEqual(["scripts/board-monitor/loop.sh"]);
    // OS PID recorded for a later targeted kill.
    expect(existsSync(join(dir, "loop.server.pid"))).toBe(true);
  });

  it("stop kills the RECORDED PID and the backstop is scoped to board-monitor.loop.sh (no sibling over-kill)", () => {
    // Arrange: a recorded server PID + a fresh log (loop currently 'alive').
    const recordedPid = 12345;
    writeFileSync(join(dir, "loop.server.pid"), String(recordedPid), "utf8");
    writeFreshLog();
    expect(readOrchestratorStatus(repo).alive).toBe(true);

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      // Act
      const result = stopConductor(repo);

      // Assert: reports the PID it acted on, and flips read-only status to not-alive
      // (stop-marker dropped) so the board reads 'stopped' immediately.
      expect(result.ok).toBe(true);
      expect(result.pid).toBe(recordedPid);
      expect(readOrchestratorStatus(repo).alive).toBe(false);

      if (process.platform === "win32") {
        // Targeted tree-kill of exactly our recorded PID — not a blanket kill.
        const taskkill = execFileMock.mock.calls.find((c) => c[0] === "taskkill");
        expect(taskkill, "expected a scoped taskkill on the recorded PID").toBeTruthy();
        expect(taskkill![1]).toEqual(["/F", "/T", "/PID", String(recordedPid)]);

        // The PowerShell backstop must be scoped to board-monitor.loop.sh command lines,
        // so it can't reap a sibling repo's loop or unrelated bash processes.
        const psCall = execFileMock.mock.calls.find((c) => c[0] === "powershell");
        expect(psCall, "expected a PowerShell backstop call").toBeTruthy();
        const psScript = (psCall![1] as string[]).join(" ");
        expect(psScript).toContain("board-monitor.loop\\.sh");
        // Only matches bash.exe loop processes — not a broad node/all-process kill.
        expect(psScript).toContain("Name='bash.exe'");
        expect(psScript).not.toContain("Name='node.exe'");
      } else {
        // POSIX: kills the recorded loop's process group by the recorded PID, not a sibling.
        expect(killSpy).toHaveBeenCalled();
        const targetedByRecorded = killSpy.mock.calls.some(
          (c) => c[0] === -recordedPid || c[0] === recordedPid,
        );
        expect(targetedByRecorded).toBe(true);
      }
    } finally {
      killSpy.mockRestore();
    }
  });
});
