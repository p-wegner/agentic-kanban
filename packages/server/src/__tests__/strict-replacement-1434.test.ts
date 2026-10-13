import { describe, it, expect, vi } from "vitest";
import { createAgentDispatch, type AgentExecutionService, type AgentLaunchRequest } from "../services/agent-dispatch.service.js";

const svc = (): AgentExecutionService => ({
  launch: vi.fn(() => ({ pid: 1 })), kill: vi.fn(() => true), sendInput: vi.fn(() => true), closeStdin: vi.fn(() => true),
  isStdinOpen: vi.fn(() => true), getProcess: vi.fn(() => ({ pid: 1 })), getPid: vi.fn(() => 1), isPidAlive: vi.fn(() => true),
});

const strictOn = (workerId: string) => ({ kind: "remote" as const, workerId, strict: true });

function setup(replace: AgentLaunchRequest["replacePlacement"]) {
  const host = svc(), remote = svc();
  const events: Array<{ type: string; data?: string }> = [];
  const dispatch = createAgentDispatch({ host, remote });
  dispatch.launch({
    worktreePath: "/w", sessionId: "s1", prompt: "p", agentArgs: undefined,
    onOutput: (e) => events.push(e as never), placement: strictOn("wsl"), replacePlacement: replace,
  });
  const failFirst = () => (vi.mocked(remote.launch).mock.calls[0][0] as AgentLaunchRequest)
    .onDeferredLaunchFailure!({ kind: "auth-expired", reason: "claude login expired" });
  return { host, remote, events, failFirst };
}

describe("#1434 strict re-placement of an auth-dead session", () => {
  it("relaunches on the worker the queued re-placement resolves", async () => {
    const t = setup(async () => strictOn("desktop"));
    t.failFirst();
    await vi.waitFor(() => expect(t.remote.launch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(t.remote.launch).mock.calls[1][0].placement).toEqual(strictOn("desktop"));
    expect(t.events.some((e) => e.type === "exit")).toBe(false);
    expect(t.host.launch).not.toHaveBeenCalled();
  });

  it("finalizes as NO_AVAILABLE_WORKER when the queue gives up", async () => {
    const t = setup(async () => { throw new Error("workers_busy for 1800s"); });
    t.failFirst();
    await vi.waitFor(() => expect(t.events.some((e) => e.type === "exit")).toBe(true));
    expect(t.events[0].data).toContain("NO_AVAILABLE_WORKER");
    expect(t.events[0].data).toContain("workers_busy");
    expect(t.host.launch).not.toHaveBeenCalled();
  });
});
