// #900, follow-up to #874: recovering a follow-up turn's ability to reach a session
// ADOPTED after a board restart.
//
// `state.turnStates` dies with the process that launched a session — not remote-specific,
// but the remote implementation is the one that can ask anyone: the worker actually holds
// the child's stdin, so its answer is a fact rather than a guess. A `waiting` turn state is
// seeded ONLY when it attests the stdin is open right now; every other outcome leaves the
// existing #874 refusal untouched (this never relaunches — a relaunch beside a still-running
// agent is exactly what that refusal exists to prevent) and records WHY, for `sendTurn`'s
// refusal message to name.
//
// Extracted from session-lifecycle.ts (#888 god-module ceiling) rather than inlined there —
// this is a cohesive, independently testable leaf with its own state (the reason ledger).

import type { AgentExecutionService } from "../agent-dispatch.service.js";
import type { SessionState } from "./types.js";

export interface RemoteTurnRecovery {
  /**
   * Recover a follow-up turn's ability to reach a session ADOPTED after a board restart.
   *
   * A no-op for a session that already has a turn state, is not remote, or whose
   * implementation cannot answer — callers may invoke this unconditionally before every
   * turn without checking placement themselves.
   */
  recover(sessionId: string): Promise<void>;
  /** The last reason `recover` could NOT recover this session, for a refusal message to name. */
  reasonFor(sessionId: string): string | undefined;
  /** Drop the recorded reason once the session is gone — it explains nothing after that. */
  forget(sessionId: string): void;
}

export function createRemoteTurnRecovery(state: SessionState, agentService: AgentExecutionService): RemoteTurnRecovery {
  const reasons = new Map<string, string>();

  async function recover(sessionId: string): Promise<void> {
    if (state.turnStates.has(sessionId)) return;
    if (agentService.placementOf?.(sessionId) !== "remote") return;
    const outcome = await agentService.probeStdinIdle?.(sessionId);
    if (!outcome) {
      reasons.set(sessionId, "this placement cannot answer whether its stdin is open");
      return;
    }
    if (!outcome.ok) {
      reasons.set(sessionId, outcome.reason);
      return;
    }
    if (!outcome.stdinOpen) {
      reasons.set(sessionId, "the fleet worker reports this session's stdin is closed");
      return;
    }
    // The agent may have finished (or another turn attempt may have landed) while the
    // probe was in flight — check again rather than overwrite a state set in the meantime.
    if (state.turnStates.has(sessionId)) return;
    reasons.delete(sessionId);
    state.turnStates.set(sessionId, "waiting");
    console.log(`[session] recovered remote turn state after restart: sessionId=${sessionId} (worker attests stdin open)`);
  }

  return {
    recover,
    reasonFor: (sessionId) => reasons.get(sessionId),
    forget: (sessionId) => { reasons.delete(sessionId); },
  };
}
