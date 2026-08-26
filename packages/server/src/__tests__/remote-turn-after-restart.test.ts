/**
 * #874 — a follow-up turn against an agent running on a fleet worker.
 *
 * The reported symptom was a refusal that said "Agent process has exited" about an agent
 * that had not exited. Root cause, established rather than assumed: the dispatch proxy
 * writes its routing entry ONLY in `launch`, and a session the remote service ADOPTED on
 * boot (#745) never went through `launch` in this process. So `forSession` fell through to
 * the host implementation, which has never heard of that session and answers `isPidAlive`
 * false — and `sendTurn`, reading exactly that, concluded the process was gone.
 *
 * Two halves are pinned below, because fixing either alone leaves a lie in place:
 *  1. ROUTING — an adopted session resolves to the remote implementation.
 *  2. THE REFUSAL — the turn is still refused (the board's copy of that agent's stdin died
 *     with the previous process), but the message now names the placement and does NOT
 *     claim an exit. The `stale` flag stays off on purpose: it is the caller's cue to
 *     relaunch, and relaunching would run a second agent beside the one still working.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import type { WorkerConnectionManager } from "../services/worker-connection.service.js";
import type { BoardToWorkerMessage, WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import { createAgentDispatch, type AgentExecutionService } from "../services/agent-dispatch.service.js";
import { createRemoteAgentService } from "../services/agent-remote.service.js";
import { createSessionState } from "../services/session-manager/types.js";
import {
  createSessionLifecycle,
  REMOTE_TURN_AFTER_RESTART,
  type AgentService,
} from "../services/session-manager/session-lifecycle.js";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

/** The minimum of a connection manager the adoption path touches: listener registration. */
function idleManager(): WorkerConnectionManager {
  return {
    send: () => false,
    isConnected: () => false,
    connectedWorkerIds: () => [],
    runningSessionIds: () => [],
    onMessage: () => () => {},
    onConnect: () => () => {},
    onDisconnect: () => () => {},
  } as unknown as WorkerConnectionManager;
}

/** A host implementation that knows nothing — which is the truth for an adopted session. */
function hostStub(): AgentExecutionService & { isPidAlive: ReturnType<typeof vi.fn> } {
  return {
    launch: vi.fn(() => ({})),
    kill: vi.fn(() => false),
    sendInput: vi.fn(() => false),
    closeStdin: vi.fn(() => false),
    isStdinOpen: vi.fn(() => false),
    getProcess: vi.fn(() => undefined),
    getPid: vi.fn(() => undefined),
    isPidAlive: vi.fn(() => false),
  } as unknown as AgentExecutionService & { isPidAlive: ReturnType<typeof vi.fn> };
}

describe("dispatch routing for an ADOPTED remote session (#874)", () => {
  let db: Database;
  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
  });

  function adopted(sessionId = "sess-adopted") {
    const host = hostStub();
    const remote = createRemoteAgentService(idleManager(), db);
    const dispatch = createAgentDispatch({ host, remote });
    remote.adoptSession({ sessionId, workerId: "w1", onOutput: () => {} });
    return { host, remote, dispatch, sessionId };
  }

  it("reports the agent ALIVE — the exact answer the false refusal was built on", () => {
    const { dispatch, sessionId, host } = adopted();
    expect(dispatch.isPidAlive(sessionId)).toBe(true);
    // Not merely "true by luck": the host must not have been consulted at all.
    expect(host.isPidAlive).not.toHaveBeenCalled();
  });

  it("names the placement as remote", () => {
    const { dispatch, sessionId } = adopted();
    expect(dispatch.placementOf?.(sessionId)).toBe("remote");
  });

  it("routes the session-keyed follow-ups to the remote service, not the host", () => {
    const { dispatch, sessionId, host } = adopted();
    dispatch.kill(sessionId);
    dispatch.sendInput(sessionId, "hi");
    dispatch.closeStdin(sessionId);
    dispatch.isStdinOpen(sessionId);
    expect(host.kill).not.toHaveBeenCalled();
    expect(host.sendInput).not.toHaveBeenCalled();
    expect(host.closeStdin).not.toHaveBeenCalled();
    expect(host.isStdinOpen).not.toHaveBeenCalled();
  });

  it("still defaults to the host for a session nobody tracks, and claims no placement for it", () => {
    // The fallback is what routing MUST do for an unknown id; asserting a placement about
    // it would be inventing a fact, so `placementOf` says nothing instead of saying "host".
    const { dispatch, host } = adopted();
    expect(dispatch.isPidAlive("never-heard-of-it")).toBe(false);
    expect(host.isPidAlive).toHaveBeenCalledWith("never-heard-of-it");
    expect(dispatch.placementOf?.("never-heard-of-it")).toBeUndefined();
  });

  it("says `host` for a session this process launched on the host", () => {
    const host = hostStub();
    const dispatch = createAgentDispatch({ host, remote: createRemoteAgentService(idleManager(), db) });
    dispatch.launch({
      worktreePath: "/tmp", sessionId: "sess-host", prompt: "p", agentArgs: undefined, onOutput: () => {},
    });
    expect(dispatch.placementOf?.("sess-host")).toBe("host");
  });
});

describe("the turn refusal tells the truth about placement (#874)", () => {
  function lifecycleWith(agent: Partial<AgentService>) {
    const { db } = createTestDb();
    const service = {
      launch: vi.fn(() => ({})),
      kill: vi.fn(() => true),
      closeStdin: vi.fn(() => true),
      getProcess: vi.fn(() => undefined),
      sendInput: vi.fn(() => true),
      isPidAlive: vi.fn(() => true),
      ...agent,
    } as unknown as AgentService;
    return createSessionLifecycle(createSessionState(), undefined, vi.fn(), { db, agentService: service });
  }

  it("refuses a turn for a remote session WITHOUT claiming the agent exited", () => {
    // The precise pre-fix combination: no turn state (it died with the old process) and a
    // host-answered `isPidAlive` of false. That produced "Agent process has exited".
    const lifecycle = lifecycleWith({
      isPidAlive: vi.fn(() => false),
      placementOf: vi.fn(() => "remote"),
    } as Partial<AgentService>);

    const result = lifecycle.sendTurn("sess-adopted", "carry on");

    expect(result.ok).toBe(false);
    expect(result.error).toBe(REMOTE_TURN_AFTER_RESTART);
    expect(result.error).not.toMatch(/has exited/);
    expect(result.error).toMatch(/fleet worker/);
    // Not stale: a relaunch would double-run the agent that is still working.
    expect(result.stale).toBeFalsy();
  });

  it("still reports a genuine exit as an exit when nothing claims a remote placement", () => {
    const lifecycle = lifecycleWith({ isPidAlive: vi.fn(() => false) } as Partial<AgentService>);
    const result = lifecycle.sendTurn("sess-gone", "carry on");
    expect(result).toMatchObject({ ok: false, error: "Agent process has exited", stale: true });
  });

  it("leaves the host non-multi-turn refusal alone", () => {
    const lifecycle = lifecycleWith({
      isPidAlive: vi.fn(() => true),
      placementOf: vi.fn(() => "host"),
    } as Partial<AgentService>);
    const result = lifecycle.sendTurn("sess-host", "carry on");
    expect(result).toMatchObject({ ok: false, error: "Session not found or not in multi-turn mode" });
  });
});

/**
 * #900 — recovering stdin state by asking the worker.
 *
 * A scripted `WorkerConnectionManager`: `send` records what was sent (so a test can pull
 * the `requestId` back out) and `emit` feeds a `session_probe_result` straight into the
 * remote service's own message handler, exactly as a real WebSocket frame would.
 */
function scriptedManager() {
  const sent: BoardToWorkerMessage[] = [];
  let handler: ((workerId: string, message: WorkerToBoardMessage) => void) | null = null;
  const manager = {
    send: (_workerId: string, message: BoardToWorkerMessage) => {
      sent.push(message);
      return true;
    },
    isConnected: () => true,
    connectedWorkerIds: () => ["w1"],
    runningSessionIds: () => [],
    onMessage: (cb: (workerId: string, message: WorkerToBoardMessage) => void) => {
      handler = cb;
      return () => {};
    },
    onConnect: () => () => {},
    onDisconnect: () => () => {},
  } as unknown as WorkerConnectionManager;
  return {
    manager,
    sent,
    emitProbeResult: (probe: { requestId: string; state: "unknown" | "running" | "exited"; stdinOpen?: boolean }) =>
      handler?.("w1", { type: "session_probe_result", sessionId: "sess-adopted", probe }),
  };
}

function lastProbeRequestId(sent: BoardToWorkerMessage[]): string {
  const probe = [...sent].reverse().find((m): m is Extract<BoardToWorkerMessage, { type: "probe_session" }> => m.type === "probe_session");
  if (!probe) throw new Error("no probe_session message was sent");
  return probe.requestId;
}

describe("recoverRemoteTurnState — asking the worker before refusing a turn (#900)", () => {
  let db: Database;
  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
  });

  function adoptedLifecycle() {
    const { manager, sent, emitProbeResult } = scriptedManager();
    const remote = createRemoteAgentService(manager, db);
    remote.adoptSession({ sessionId: "sess-adopted", workerId: "w1", onOutput: () => {} });
    const dispatch = createAgentDispatch({ host: hostStub(), remote });
    const lifecycle = createSessionLifecycle(createSessionState(), undefined, vi.fn(), { db, agentService: dispatch });
    return { lifecycle, sent, emitProbeResult };
  }

  it("seeds a waiting turn state and lets the follow-up turn through when the worker attests stdin is open", async () => {
    const { lifecycle, sent, emitProbeResult } = adoptedLifecycle();

    // Before recovery: refused exactly as #874 established.
    expect(lifecycle.sendTurn("sess-adopted", "carry on")).toMatchObject({
      ok: false,
      error: REMOTE_TURN_AFTER_RESTART,
    });

    const recovery = lifecycle.recoverRemoteTurnState("sess-adopted");
    emitProbeResult({ requestId: lastProbeRequestId(sent), state: "running", stdinOpen: true });
    await recovery;

    const result = lifecycle.sendTurn("sess-adopted", "carry on");
    expect(result.ok).toBe(true);
  });

  it("leaves the refusal in place, naming what the worker reported, when stdin is closed", async () => {
    const { lifecycle, sent, emitProbeResult } = adoptedLifecycle();

    const recovery = lifecycle.recoverRemoteTurnState("sess-adopted");
    emitProbeResult({ requestId: lastProbeRequestId(sent), state: "running", stdinOpen: false });
    await recovery;

    const result = lifecycle.sendTurn("sess-adopted", "carry on");
    expect(result.ok).toBe(false);
    expect(result.error).toContain(REMOTE_TURN_AFTER_RESTART);
    expect(result.error).toMatch(/stdin is closed/);
    // Not stale: still a refusal, never a cue to relaunch beside a live agent.
    expect(result.stale).toBeFalsy();
  });

  it("never reads silence as an open stdin — an unanswered probe leaves the same refusal", async () => {
    // A separate service instance with a short probe timeout, so the test does not wait
    // out the real 30s default. Nothing ever calls emitProbeResult: this IS the silence.
    const manager = scriptedManager().manager;
    const remote = createRemoteAgentService(manager, db, { probeTimeoutMs: 20 });
    remote.adoptSession({ sessionId: "sess-adopted", workerId: "w1", onOutput: () => {} });
    const dispatch = createAgentDispatch({ host: hostStub(), remote });
    const lifecycle = createSessionLifecycle(createSessionState(), undefined, vi.fn(), { db, agentService: dispatch });

    await lifecycle.recoverRemoteTurnState("sess-adopted");

    const result = lifecycle.sendTurn("sess-adopted", "carry on");
    expect(result.ok).toBe(false);
    expect(result.error).toContain(REMOTE_TURN_AFTER_RESTART);
    expect(result.error).toMatch(/did not answer/);
    expect(result.stale).toBeFalsy();
  });

  it("does nothing for a HOST session — never asks the worker anything", async () => {
    const host = hostStub();
    const { manager, sent } = scriptedManager();
    const dispatch = createAgentDispatch({ host, remote: createRemoteAgentService(manager, db) });
    dispatch.launch({
      worktreePath: "/tmp", sessionId: "sess-host", prompt: "p", agentArgs: undefined, onOutput: () => {},
    });
    const lifecycle = createSessionLifecycle(createSessionState(), undefined, vi.fn(), { db, agentService: dispatch });
    await lifecycle.recoverRemoteTurnState("sess-host");
    expect(sent).toEqual([]);
    expect(host.sendInput).not.toHaveBeenCalled();
  });
});
