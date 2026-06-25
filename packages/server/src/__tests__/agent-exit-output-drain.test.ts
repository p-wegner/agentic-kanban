import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, appendFileSync, existsSync, unlinkSync } from "node:fs";

// Mock ONLY child_process so we control the proc + exit timing. node:fs stays REAL
// so the detached-agent output file path exercises the actual read-to-EOF drain
// logic against a real temp file — this is what the exit-before-output race needs.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

import { launch, agentState } from "../services/agent.service.js";
import { spawn as spawnMock } from "node:child_process";
import { sessionOutputPath } from "../lib/session-paths.js";
import { createMockProc } from "./helpers/mocks.js";

/**
 * Regression test for #909: the exit-before-output race.
 *
 * Detached agents stream stdout via a 500ms file poll. A fast crash that writes
 * output and exits within a single poll interval fires the `exit` event before
 * the poll flushed the tail. Launch-failure classification then reads
 * `hadSubstantiveOutput` as false and MISCLASSIFIES a real run as a zero-output
 * launch failure (the recurring "~1s, 0 tokens = launch-failed").
 *
 * The fix: do one explicit final drain of the .out file to EOF on exit, BEFORE
 * emitting the exit event. This test simulates output landing in the file with
 * NO poll tick having occurred, then fires exit, and asserts the stdout drain
 * arrives before exit.
 */
describe("agent.service exit-before-output drain (#909)", () => {
  const sessionId = "drain-909";
  const outPath = sessionOutputPath(sessionId);
  const originalAgentCommand = process.env.AGENT_COMMAND;

  beforeEach(() => {
    vi.clearAllMocks();
    // No AGENT_COMMAND + claude provider (no agentCommand, not mock) => useShell=false
    // => detached path (even on win32), which is the file-poll path under test.
    delete process.env.AGENT_COMMAND;
    agentState.reset();
    vi.useFakeTimers();
    try { if (existsSync(outPath)) unlinkSync(outPath); } catch { /* ignore */ }
  });

  afterEach(() => {
    vi.useRealTimers();
    agentState.reset();
    try { if (existsSync(outPath)) unlinkSync(outPath); } catch { /* ignore */ }
    if (originalAgentCommand !== undefined) {
      process.env.AGENT_COMMAND = originalAgentCommand;
    } else {
      delete process.env.AGENT_COMMAND;
    }
  });

  it("drains the .out file tail to EOF on exit before emitting the exit event", () => {
    const mockProc = createMockProc();
    (spawnMock as any).mockReturnValue(mockProc);

    const events: { type: string; data?: string }[] = [];
    const onOutput = (e: any) => events.push({ type: e.type, data: e.data });

    // Launch as claude (no agentCommand) => detached file-poll path.
    launch("/tmp", sessionId, "prompt", undefined, onOutput, undefined, undefined, undefined, undefined, undefined, undefined, "claude");

    // The detached launch opens the .out file (openSync "w"). Spawn is mocked, so the
    // "agent" never actually writes — we simulate its final-second output landing in
    // the file WITHOUT advancing the 500ms poll timer, reproducing the race exactly.
    appendFileSync(outPath, "real assistant output before crash");

    // Fire exit. The drain must apply the file tail BEFORE the exit event.
    const exitHandler = mockProc.on.mock.calls.find((c: any[]) => c[0] === "exit")?.[1] as (...a: unknown[]) => unknown;
    expect(exitHandler).toBeDefined();
    exitHandler(1, null);

    const stdoutIdx = events.findIndex((e) => e.type === "stdout" && e.data?.includes("real assistant output before crash"));
    const exitIdx = events.findIndex((e) => e.type === "exit");

    expect(stdoutIdx).toBeGreaterThanOrEqual(0); // tail was drained, not lost
    expect(exitIdx).toBeGreaterThanOrEqual(0);
    expect(stdoutIdx).toBeLessThan(exitIdx); // applied BEFORE classification reads it
  });

  it("does not re-emit content the poll already consumed", () => {
    const mockProc = createMockProc();
    (spawnMock as any).mockReturnValue(mockProc);

    const events: { type: string; data?: string }[] = [];
    const onOutput = (e: any) => events.push({ type: e.type, data: e.data });

    launch("/tmp", sessionId, "prompt", undefined, onOutput, undefined, undefined, undefined, undefined, undefined, undefined, "claude");

    // First chunk consumed by a normal poll tick.
    appendFileSync(outPath, "first chunk ");
    vi.advanceTimersByTime(500);
    // Second chunk arrives after the last poll, just before exit.
    appendFileSync(outPath, "second chunk");

    const exitHandler = mockProc.on.mock.calls.find((c: any[]) => c[0] === "exit")?.[1] as (...a: unknown[]) => unknown;
    exitHandler(0, null);

    const stdoutData = events.filter((e) => e.type === "stdout").map((e) => e.data ?? "").join("");
    // Each byte appears exactly once: poll got "first chunk ", drain got "second chunk".
    expect(stdoutData).toBe("first chunk second chunk");
  });
});
