import { describe, expect, it, vi } from "vitest";
// @ts-ignore — scripts/ is .mjs, not in tsconfig
import { reapStaleSupervisors } from "../../../../scripts/stale-supervisor.mjs";

const CHECKOUT = "C:/andrena/agentic-kanban";
const SERVER_PORT = 3001;

function makeProc(pid: number, commandLine: string) {
  return { pid, commandLine };
}

describe("reapStaleSupervisors", () => {
  it("does nothing when no other dev.mjs supervisors are running", () => {
    const kill = vi.fn(() => true);
    const exitProcess = vi.fn();
    reapStaleSupervisors({
      checkoutRoot: CHECKOUT,
      serverPort: SERVER_PORT,
      listProcs: () => [],
      checkPort: () => false,
      kill,
      exitProcess,
    });
    expect(kill).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it("exits early when a healthy supervisor is already serving the port", () => {
    const kill = vi.fn(() => true);
    const exitProcess = vi.fn();
    reapStaleSupervisors({
      checkoutRoot: CHECKOUT,
      serverPort: SERVER_PORT,
      listProcs: () => [
        makeProc(1001, `node ${CHECKOUT}/scripts/dev.mjs`),
      ],
      checkPort: () => true,
      kill,
      exitProcess,
    });
    expect(exitProcess).toHaveBeenCalledWith(0);
    expect(kill).not.toHaveBeenCalled();
  });

  it("reaps a stale supervisor that belongs to this checkout but is not serving the port", () => {
    const kill = vi.fn(() => true);
    const exitProcess = vi.fn();
    reapStaleSupervisors({
      checkoutRoot: CHECKOUT,
      serverPort: SERVER_PORT,
      listProcs: () => [
        makeProc(2001, `node ${CHECKOUT}/scripts/dev.mjs`),
      ],
      checkPort: () => false,
      kill,
      exitProcess,
    });
    expect(kill).toHaveBeenCalledWith(2001);
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it("reaps multiple stale supervisors for the same checkout", () => {
    const kill = vi.fn(() => true);
    const exitProcess = vi.fn();
    reapStaleSupervisors({
      checkoutRoot: CHECKOUT,
      serverPort: SERVER_PORT,
      listProcs: () => [
        makeProc(3001, `node ${CHECKOUT}/scripts/dev.mjs`),
        makeProc(3002, `node ${CHECKOUT}/scripts/dev.mjs`),
        makeProc(3003, `node ${CHECKOUT}/scripts/dev.mjs`),
      ],
      checkPort: () => false,
      kill,
      exitProcess,
    });
    expect(kill).toHaveBeenCalledTimes(3);
    expect(kill).toHaveBeenCalledWith(3001);
    expect(kill).toHaveBeenCalledWith(3002);
    expect(kill).toHaveBeenCalledWith(3003);
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it("ignores a supervisor from a different checkout", () => {
    const kill = vi.fn(() => true);
    const exitProcess = vi.fn();
    reapStaleSupervisors({
      checkoutRoot: CHECKOUT,
      serverPort: SERVER_PORT,
      listProcs: () => [
        makeProc(4001, "node C:/other-project/scripts/dev.mjs"),
      ],
      checkPort: () => false,
      kill,
      exitProcess,
    });
    expect(kill).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it("ignores a worktree supervisor even though it shares the same repo root", () => {
    // Worktree path does NOT match the main checkout root as a boundary.
    const kill = vi.fn(() => true);
    const exitProcess = vi.fn();
    reapStaleSupervisors({
      checkoutRoot: CHECKOUT,
      serverPort: SERVER_PORT,
      listProcs: () => [
        // Different worktree — path starts with a different prefix, not checkoutRoot
        makeProc(5001, "node C:/andrena/.worktrees/feature_ak-200-foo/scripts/dev.mjs"),
      ],
      checkPort: () => false,
      kill,
      exitProcess,
    });
    expect(kill).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it("does not reap the current process's own PID", () => {
    const kill = vi.fn(() => true);
    const exitProcess = vi.fn();
    // listProcs includes current PID — stale-supervisor.mjs filters it out
    reapStaleSupervisors({
      checkoutRoot: CHECKOUT,
      serverPort: SERVER_PORT,
      listProcs: () => [
        makeProc(process.pid, `node ${CHECKOUT}/scripts/dev.mjs`),
      ],
      checkPort: () => false,
      kill,
      exitProcess,
    });
    expect(kill).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it("continues reaping remaining stale supervisors when one kill fails", () => {
    let callCount = 0;
    const kill = vi.fn(() => { callCount++; return callCount !== 1; });
    const exitProcess = vi.fn();
    reapStaleSupervisors({
      checkoutRoot: CHECKOUT,
      serverPort: SERVER_PORT,
      listProcs: () => [
        makeProc(6001, `node ${CHECKOUT}/scripts/dev.mjs`),
        makeProc(6002, `node ${CHECKOUT}/scripts/dev.mjs`),
      ],
      checkPort: () => false,
      kill,
      exitProcess,
    });
    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledWith(6001);
    expect(kill).toHaveBeenCalledWith(6002);
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it("handles backslash paths in command lines (Windows)", () => {
    const kill = vi.fn(() => true);
    const exitProcess = vi.fn();
    reapStaleSupervisors({
      checkoutRoot: CHECKOUT,
      serverPort: SERVER_PORT,
      listProcs: () => [
        makeProc(7001, `node C:\\andrena\\agentic-kanban\\scripts\\dev.mjs`),
      ],
      checkPort: () => false,
      kill,
      exitProcess,
    });
    // commandLineBelongsToCheckout normalises slashes so this should be reaped
    expect(kill).toHaveBeenCalledWith(7001);
    expect(exitProcess).not.toHaveBeenCalled();
  });
});
