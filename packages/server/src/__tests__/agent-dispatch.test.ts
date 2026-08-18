import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createAgentDispatch,
  WorkerDispatchUnavailableError,
  type AgentExecutionService,
  type Placement,
} from "../services/agent-dispatch.service.js";
import type { AgentOutputCallback } from "../services/agent.service.js";

function mockExecutionService(pid: number): AgentExecutionService {
  return {
    launch: vi.fn(() => ({ pid })),
    kill: vi.fn(() => true),
    sendInput: vi.fn(() => true),
    closeStdin: vi.fn(() => true),
    isStdinOpen: vi.fn(() => true),
    getProcess: vi.fn(() => ({ pid })),
    getPid: vi.fn(() => pid),
    isPidAlive: vi.fn(() => true),
  };
}

function launchOn(
  dispatch: AgentExecutionService,
  sessionId: string,
  placement?: Placement,
  onOutput: AgentOutputCallback = () => {},
) {
  // #524: was fifteen `undefined`s positioned so that `placement` landed in slot 20.
  return dispatch.launch({
    worktreePath: "/worktree", sessionId, prompt: "do the thing",
    agentArgs: undefined, onOutput, placement,
  });
}

describe("agent-dispatch", () => {
  let host: AgentExecutionService;
  let remote: AgentExecutionService;

  beforeEach(() => {
    host = mockExecutionService(101);
    remote = mockExecutionService(202);
  });

  it("routes launch to host when no placement is given", () => {
    const dispatch = createAgentDispatch({ host, remote });
    const handle = launchOn(dispatch, "s1");
    expect(host.launch).toHaveBeenCalledOnce();
    expect(remote.launch).not.toHaveBeenCalled();
    expect(handle.pid).toBe(101);
  });

  it("routes launch to the remote implementation for a remote placement", () => {
    const dispatch = createAgentDispatch({ host, remote });
    const handle = launchOn(dispatch, "s1", { kind: "remote", workerId: "w1" });
    expect(remote.launch).toHaveBeenCalledOnce();
    expect(host.launch).not.toHaveBeenCalled();
    expect(handle.pid).toBe(202);
  });

  it("falls back to host when remote is requested but not registered", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispatch = createAgentDispatch({ host });
    const handle = launchOn(dispatch, "s1", { kind: "remote", workerId: "w1" });
    expect(host.launch).toHaveBeenCalledOnce();
    expect(handle.pid).toBe(101);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("falling back to host"));
    warn.mockRestore();
  });

  it("routes session-keyed follow-ups to the implementation that launched the session", () => {
    const dispatch = createAgentDispatch({ host, remote });
    launchOn(dispatch, "remote-session", { kind: "remote", workerId: "w1" });
    launchOn(dispatch, "host-session", { kind: "host" });

    dispatch.sendInput("remote-session", "hi");
    dispatch.closeStdin("remote-session");
    dispatch.isPidAlive("remote-session");
    expect(remote.sendInput).toHaveBeenCalledWith("remote-session", "hi");
    expect(remote.closeStdin).toHaveBeenCalledWith("remote-session");
    expect(remote.isPidAlive).toHaveBeenCalledWith("remote-session");
    expect(host.sendInput).not.toHaveBeenCalled();

    dispatch.kill("host-session");
    expect(host.kill).toHaveBeenCalledWith("host-session");
    expect(remote.kill).not.toHaveBeenCalled();
  });

  it("defaults unknown sessions to host (reattach/stale paths)", () => {
    const dispatch = createAgentDispatch({ host, remote });
    dispatch.kill("never-launched");
    expect(host.kill).toHaveBeenCalledWith("never-launched");
  });

  it("clears the session routing on exit so later calls fall back to host", () => {
    const dispatch = createAgentDispatch({ host, remote });
    const seen: string[] = [];
    launchOn(dispatch, "s1", { kind: "remote", workerId: "w1" }, (e) => seen.push(e.type));

    // The wrapped callback passed to the implementation is what fires events.
    // #524: read by NAME. This was `mock.calls[0][4]` — the test knew onOutput was the
    // fifth positional argument, so appending a parameter anywhere before it would have
    // broken this assertion for reasons having nothing to do with what it checks.
    const wrapped = (remote.launch as ReturnType<typeof vi.fn>).mock.calls[0][0].onOutput as AgentOutputCallback;
    wrapped({ type: "stdout", sessionId: "s1", data: "x" });
    expect(seen).toEqual(["stdout"]);
    dispatch.sendInput("s1", "still remote");
    expect(remote.sendInput).toHaveBeenCalledOnce();

    wrapped({ type: "exit", sessionId: "s1", exitCode: 0 });
    expect(seen).toEqual(["stdout", "exit"]);
    dispatch.sendInput("s1", "now host");
    expect(host.sendInput).toHaveBeenCalledWith("s1", "now host");
    expect(remote.sendInput).toHaveBeenCalledOnce();
  });

  describe("strict worker dispatch refuses the host fallback (#245)", () => {
    it("falls back to host when a NON-strict remote launch throws", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      (remote.launch as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("fleet worker w1 is not connected");
      });
      const dispatch = createAgentDispatch({ host, remote });
      const handle = launchOn(dispatch, "s1", { kind: "remote", workerId: "w1" });
      expect(handle.pid).toBe(101);
      expect(host.launch).toHaveBeenCalledOnce();
      warn.mockRestore();
    });

    it("fails the session instead when the remote launch throws under strict", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      (remote.launch as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("fleet worker w1 is not connected");
      });
      const dispatch = createAgentDispatch({ host, remote });
      expect(() => launchOn(dispatch, "s1", { kind: "remote", workerId: "w1", strict: true }))
        .toThrow(WorkerDispatchUnavailableError);
      expect(host.launch).not.toHaveBeenCalled();
      // The routing entry is cleared, so follow-ups don't point at a dead impl.
      dispatch.kill("s1");
      expect(remote.kill).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("refuses a strict remote placement when no remote implementation is registered", () => {
      const dispatch = createAgentDispatch({ host });
      let thrown: unknown;
      try {
        launchOn(dispatch, "s1", { kind: "remote", workerId: "w1", strict: true });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WorkerDispatchUnavailableError);
      expect((thrown as WorkerDispatchUnavailableError).code).toBe("NO_AVAILABLE_WORKER");
      expect(host.launch).not.toHaveBeenCalled();
    });
  });

  it("clears the session routing on kill", () => {
    const dispatch = createAgentDispatch({ host, remote });
    launchOn(dispatch, "s1", { kind: "remote", workerId: "w1" });
    dispatch.kill("s1");
    expect(remote.kill).toHaveBeenCalledWith("s1");
    dispatch.sendInput("s1", "after kill");
    expect(host.sendInput).toHaveBeenCalledWith("s1", "after kill");
  });
});
