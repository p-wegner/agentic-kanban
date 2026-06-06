import { describe, expect, it, vi } from "vitest";
// @ts-ignore - scripts/ is .mjs, not in tsconfig
import { planStaleSupervisorReap, reapStaleSupervisors } from "../../../../scripts/stale-supervisor.mjs";

const CHECKOUT = "C:/andrena/agentic-kanban";
const SERVER_PORT = 3001;

function makeProc(pid: number, commandLine: string, ppid = 0) {
  return { pid, ppid, commandLine };
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
      listeningPids: new Set([1001]),
      kill,
      exitProcess,
    });
    expect(exitProcess).toHaveBeenCalledWith(0);
    expect(kill).not.toHaveBeenCalled();
  });

  it("treats a supervisor as healthy when its descendant serves the expected port", () => {
    const kill = vi.fn(() => true);
    const exitProcess = vi.fn();
    reapStaleSupervisors({
      checkoutRoot: CHECKOUT,
      serverPort: SERVER_PORT,
      listProcs: () => [
        makeProc(1101, `node ${CHECKOUT}/scripts/dev.mjs`),
        makeProc(1102, `node ${CHECKOUT}/packages/server/node_modules/tsx/dist/cli.mjs watch src/index.ts`, 1101),
      ],
      listeningPids: new Set([1102]),
      kill,
      exitProcess,
    });
    expect(kill).not.toHaveBeenCalled();
    expect(exitProcess).toHaveBeenCalledWith(0);
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

  it("reaps stale supervisors and exits when a serving same-checkout supervisor exists", () => {
    const kill = vi.fn(() => true);
    const exitProcess = vi.fn();
    reapStaleSupervisors({
      checkoutRoot: CHECKOUT,
      serverPort: SERVER_PORT,
      listProcs: () => [
        makeProc(3001, `node ${CHECKOUT}/scripts/dev.mjs`),
        makeProc(3002, `node ${CHECKOUT}/scripts/dev.mjs`),
      ],
      isServingPid: (pid) => pid === 3001,
      checkPort: () => true,
      kill,
      exitProcess,
    });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(3002);
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it("reaps stale supervisors then exits when a same-checkout serving process was not found", () => {
    const kill = vi.fn(() => true);
    const exitProcess = vi.fn();
    reapStaleSupervisors({
      checkoutRoot: CHECKOUT,
      serverPort: SERVER_PORT,
      listProcs: () => [
        makeProc(4001, `node ${CHECKOUT}/scripts/dev.mjs`),
      ],
      isServingPid: () => false,
      checkPort: () => true,
      kill,
      exitProcess,
    });
    expect(kill).toHaveBeenCalledWith(4001);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(exitProcess).toHaveBeenCalledWith(0);
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
    const kill = vi.fn(() => true);
    const exitProcess = vi.fn();
    reapStaleSupervisors({
      checkoutRoot: CHECKOUT,
      serverPort: SERVER_PORT,
      listProcs: () => [
        makeProc(5001, "node C:/andrena/.worktrees/feature_ak-200-foo/scripts/dev.mjs"),
      ],
      checkPort: () => false,
      kill,
      exitProcess,
    });
    expect(kill).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it("does not include a different worktree supervisor even when that worktree has a listener", () => {
    const plan = planStaleSupervisorReap({
      checkoutRoot: CHECKOUT,
      serverPort: SERVER_PORT,
      processes: [
        makeProc(5101, "node C:/andrena/.worktrees/feature_ak-200-foo/scripts/dev.mjs"),
        makeProc(5102, "node C:/andrena/.worktrees/feature_ak-200-foo/packages/server/src/index.ts", 5101),
      ],
      servingPids: new Set([5102]),
      portListening: true,
    });

    expect(plan.candidates).toHaveLength(0);
    expect(plan.stale).toHaveLength(0);
    expect(plan.serving).toBeNull();
    expect(plan.portBlocked).toBe(false);
  });

  it("does not reap the current process's own PID", () => {
    const kill = vi.fn(() => true);
    const exitProcess = vi.fn();
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
    expect(kill).toHaveBeenCalledWith(7001);
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it("does not kill unrelated same-checkout node processes", () => {
    const kill = vi.fn(() => true);
    const exitProcess = vi.fn();
    reapStaleSupervisors({
      checkoutRoot: CHECKOUT,
      serverPort: SERVER_PORT,
      listProcs: () => [
        makeProc(8001, `node ${CHECKOUT}/scripts/other-tool.mjs`),
      ],
      listeningPids: new Set([8001]),
      kill,
      exitProcess,
    });
    expect(kill).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
  });

  it("does not treat an unrelated listener as proof that a same-checkout supervisor is healthy", () => {
    const kill = vi.fn(() => true);
    const exitProcess = vi.fn();
    reapStaleSupervisors({
      checkoutRoot: CHECKOUT,
      serverPort: SERVER_PORT,
      listProcs: () => [
        makeProc(8101, `node ${CHECKOUT}/scripts/dev.mjs`),
        makeProc(8102, `node ${CHECKOUT}/scripts/other-tool.mjs`),
      ],
      listeningPids: new Set([8102]),
      kill,
      exitProcess,
    });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(8101);
    expect(kill).not.toHaveBeenCalledWith(8102);
    expect(exitProcess).toHaveBeenCalledWith(0);
  });
});
