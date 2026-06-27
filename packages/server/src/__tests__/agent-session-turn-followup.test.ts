// @covers agent-sessions.turn.followup [workflow,error-handling]
//
// A follow-up turn (`sendTurn`) CONTINUES the existing multi-turn session rather than
// spawning a fresh one. The real `createSessionLifecycle().sendTurn` is exercised end-to-end
// against an injected agent-service boundary, so we observe the actual gate the behaviour
// describes (session-lifecycle.ts:813):
//
//   WORKFLOW (continue-same-session) — a turn on a `waiting` + verified-alive session is
//     delivered to the SAME live process via `sendInput(sessionId, content)` and the turn state
//     flips waiting→processing. This is the "follow-up continues the session" promise: the
//     conversation/context is preserved because the same stdin-open process receives the content.
//
//   ERROR-HANDLING — the precondition is `turnState==waiting` AND a verified-alive process AND a
//     successful stdin write. A dead process (or a session absent from `turnStates`) returns
//     `stale:true` so the caller knows to resume into a fresh session; a still-processing (alive)
//     session is rejected as busy WITHOUT `stale`; a mid-flight stdin failure (`sendInput` returns
//     false) returns `ok:false` without flipping to processing. In every refusal the turn is not
//     delivered and the state is left intact.
//
// Why this is the gap: the existing `session.manager.test.ts` cases re-derive the state machine
// INLINE (touches-only Maps), never calling the real `sendTurn`. So the waiting-AND-alive
// precondition and the refusal branches were not exercised against production code.
//
// Mutation check — each assertion goes RED on a real regression:
//   * If the delivery were dropped (sendTurn stopped writing the content to stdin or stopped
//     flipping the state), the workflow case's `sendInput`/`processing` assertions fail.
//   * If the alive-gate were dropped (sendTurn delivered to a dead process), the stale case would
//     return `{ ok: true }` and `sendInput` would be called → the `stale:true` / not-delivered
//     assertions fail.
//   * If the busy-gate were dropped, the processing case would deliver a concurrent turn →
//     `sendInput` called / state lost → the busy assertions fail.
//   * If the `!sent` guard were dropped, a failed stdin write would still flip to processing →
//     the stdin-failure case's `ok:false` / state-stays-waiting assertions fail.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createSessionState } from "../services/session-manager/types.js";
import { createSessionLifecycle } from "../services/session-manager/session-lifecycle.js";
import type { AgentService, SessionLifecycleDeps } from "../services/session-manager/session-lifecycle.js";
import { createTestDb } from "./helpers/test-db.js";

// Keep the stale-cleanup's fire-and-forget DB writes off the real DB.
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "log").mockImplementation(() => {});

/**
 * Build a lifecycle whose agent-service boundary is fully controllable:
 *   - `alive` decides `isPidAlive` (the verified-alive precondition),
 *   - `sendOk` decides whether the stdin write succeeds (`sendInput`'s return value),
 *   - `sendInput` records the delivered turn content.
 */
function makeLifecycle(alive: boolean, sendOk = true) {
  const sendInput = vi.fn((_sessionId: string, _content: string) => sendOk);
  const agentService = {
    launch: vi.fn(),
    kill: vi.fn(() => true),
    closeStdin: vi.fn(() => true),
    getProcess: vi.fn(() => undefined),
    sendInput,
    isPidAlive: vi.fn(() => alive),
  } as unknown as AgentService;

  const { db } = createTestDb();
  const state = createSessionState();
  const deps: SessionLifecycleDeps = { db, agentService };
  const lifecycle = createSessionLifecycle(state, undefined, vi.fn(), deps);
  return { lifecycle, state, sendInput };
}

describe("agent-sessions.turn.followup — sendTurn continues the existing session", () => {
  let sessionId: string;
  beforeEach(() => {
    sessionId = randomUUID();
  });

  describe("WORKFLOW: a follow-up turn on a waiting + alive session is delivered to the SAME process", () => {
    it("delivers the content via the live process's stdin and flips waiting→processing", async () => {
      const { lifecycle, state, sendInput } = makeLifecycle(/* alive */ true);
      // Arrange: a multi-turn session that has just completed its prior turn (waiting, stdin open).
      state.turnStates.set(sessionId, "waiting");

      const content = "please also update the README";
      const result = lifecycle.sendTurn(sessionId, content);

      // The follow-up proceeded...
      expect(result).toEqual({ ok: true });
      // ...delivered to the SAME existing live process (continuing the session, not a new turn-1)...
      expect(sendInput).toHaveBeenCalledTimes(1);
      expect(sendInput).toHaveBeenCalledWith(sessionId, content);
      // ...and the turn state advanced waiting→processing.
      expect(lifecycle.getTurnState(sessionId)).toBe("processing");
      expect(state.turnStates.get(sessionId)).toBe("processing");
    });
  });

  describe("ERROR-HANDLING: the gate refuses to deliver when the precondition is not met", () => {
    it("returns stale (resume-fresh signal) and delivers nothing when the process is DEAD in a waiting session", () => {
      const { lifecycle, state, sendInput } = makeLifecycle(/* alive */ false);
      state.turnStates.set(sessionId, "waiting");

      const result = lifecycle.sendTurn(sessionId, "follow up");

      expect(result.ok).toBe(false);
      expect(result.stale).toBe(true);
      // No turn was delivered into a dead process.
      expect(sendInput).not.toHaveBeenCalled();
    });

    it("returns stale when the session is unknown (absent from turnStates) and the process is gone", () => {
      const { lifecycle, sendInput } = makeLifecycle(/* alive */ false);
      // No turnStates entry at all — treated as exited.

      const result = lifecycle.sendTurn(sessionId, "follow up");

      expect(result.ok).toBe(false);
      expect(result.stale).toBe(true);
      expect(sendInput).not.toHaveBeenCalled();
    });

    it("rejects a concurrent turn (busy, NOT stale) while the previous turn is still processing", () => {
      const { lifecycle, state, sendInput } = makeLifecycle(/* alive */ true);
      // The prior turn has not completed yet (no turnComplete event → still processing).
      state.turnStates.set(sessionId, "processing");

      const result = lifecycle.sendTurn(sessionId, "second turn before first finished");

      expect(result.ok).toBe(false);
      // Busy is distinct from stale: the alive session must NOT be torn down / resumed-fresh.
      expect(result.stale).toBeUndefined();
      // And the second turn is not delivered — no concurrent interleaving on one session.
      expect(sendInput).not.toHaveBeenCalled();
      // The state is unchanged (still processing the first turn).
      expect(state.turnStates.get(sessionId)).toBe("processing");
    });

    it("returns ok:false and does NOT flip to processing when the stdin write fails mid-flight", () => {
      // Alive + waiting, but the agent's stdin closed between the alive-check and the write:
      // sendInput returns false. The turn must NOT be considered in-flight.
      const { lifecycle, state, sendInput } = makeLifecycle(/* alive */ true, /* sendOk */ false);
      state.turnStates.set(sessionId, "waiting");

      const result = lifecycle.sendTurn(sessionId, "follow up that fails to write");

      // The write was attempted (the gate passed) but reported failure...
      expect(sendInput).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/failed to send input/i);
      // ...not a stale signal (the process is alive — this is a write failure, not an exit)...
      expect(result.stale).toBeUndefined();
      // ...and the state stayed `waiting` (no false "processing" flip on a failed delivery).
      expect(state.turnStates.get(sessionId)).toBe("waiting");
    });
  });
});
