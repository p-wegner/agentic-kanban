import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAgentDispatch, type AgentExecutionService, type Placement } from "../services/agent-dispatch.service.js";
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
  return dispatch.launch(
    "/worktree", sessionId, "do the thing", undefined, onOutput,
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, placement,
  );
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
    const wrapped = (remote.launch as ReturnType<typeof vi.fn>).mock.calls[0][4] as AgentOutputCallback;
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

  it("clears the session routing on kill", () => {
    const dispatch = createAgentDispatch({ host, remote });
    launchOn(dispatch, "s1", { kind: "remote", workerId: "w1" });
    dispatch.kill("s1");
    expect(remote.kill).toHaveBeenCalledWith("s1");
    dispatch.sendInput("s1", "after kill");
    expect(host.sendInput).toHaveBeenCalledWith("s1", "after kill");
  });
});
