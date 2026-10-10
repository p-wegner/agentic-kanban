// The disconnect/reconnect hold for remote sessions (#746), lifted out of
// createRemoteAgentService (#1345).
//
// A lost socket is a lost VIEW, not a dead agent (#746). The old rule synthesized
// exit(1) for every session on the worker after 60s — destroying a run the worker was
// still executing, and pre-empting its push. So the gap has two bounds and they mean
// different things:
//
//   graceMs   -> REPORT. The session is marked DETACHED and the hold is written into
//                its own transcript. Nothing is finalized; a reconnect re-adopts it.
//   abandonMs -> GIVE UP. Only now is the session finalized, and only after landing
//                anything the worker managed to push.
import type { BoardEndedReason } from "./agent-remote-events.js";
import type { WorkerConnectionManager } from "./worker-connection.service.js";
import type { RemoteSession } from "./agent-remote.types.js";

export function installRemoteSessionHold(deps: {
  manager: WorkerConnectionManager;
  sessions: Map<string, RemoteSession>;
  graceMs: number;
  abandonMs: number;
  report: (sessionId: string, session: RemoteSession, text: string) => void;
  landAndFinish: (sessionId: string, session: RemoteSession, exitCode: number | null, endedBy?: BoardEndedReason) => Promise<void>;
}): void {
  const { manager, sessions, graceMs, abandonMs, report, landAndFinish } = deps;
  const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const abandonTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearWorkerTimers(workerId: string): void {
    const grace = disconnectTimers.get(workerId);
    if (grace) { clearTimeout(grace); disconnectTimers.delete(workerId); }
    const abandon = abandonTimers.get(workerId);
    if (abandon) { clearTimeout(abandon); abandonTimers.delete(workerId); }
  }

  manager.onDisconnect((workerId) => {
    const affected = [...sessions.entries()].filter(([, s]) => s.workerId === workerId);
    if (affected.length === 0) return;
    console.warn(
      `[agent-remote] worker ${workerId} disconnected with ${affected.length} session(s); ` +
      `holding — reporting at ${Math.round(graceMs / 1000)}s, giving up at ${Math.round(abandonMs / 60000)}m`,
    );
    clearWorkerTimers(workerId);

    const graceTimer = setTimeout(() => {
      disconnectTimers.delete(workerId);
      const detachedAt = Date.now();
      for (const [sessionId, session] of sessions.entries()) {
        if (session.workerId !== workerId) continue;
        session.detachedSinceMs = detachedAt;
        console.warn(
          `[agent-remote] worker ${workerId} has not reconnected in ${Math.round(graceMs / 1000)}s; ` +
            `session ${sessionId} is DETACHED (held, not failed) until ${Math.round(abandonMs / 60000)}m`,
        );
        report(
          sessionId,
          session,
          `Lost the connection to fleet worker ${workerId} ${Math.round(graceMs / 1000)}s ago. The agent is ` +
            `most likely still running there; the board simply cannot see it, so live output is dropped from ` +
            `here on. This session is HELD, not failed — it resumes if the worker reconnects within ` +
            `${Math.round(abandonMs / 60000)} minutes.`,
        );
      }
    }, graceMs);
    if (graceTimer.unref) graceTimer.unref();
    disconnectTimers.set(workerId, graceTimer);

    const abandonTimer = setTimeout(() => {
      abandonTimers.delete(workerId);
      for (const [sessionId, session] of [...sessions.entries()]) {
        if (session.workerId !== workerId) continue;
        console.error(
          `[agent-remote] worker ${workerId} silent for ${Math.round(abandonMs / 60000)}m; abandoning session ${sessionId}`,
        );
        report(
          sessionId,
          session,
          `Fleet worker ${workerId} has been unreachable for ${Math.round(abandonMs / 60000)} minutes. Giving ` +
            `up on this session. If the worker pushed a result before it vanished it is being landed on the ` +
            `branch now; otherwise its work remains only in the worker's own clone.`,
        );
        void landAndFinish(sessionId, session, 1, "abandoned");
      }
    }, abandonMs);
    if (abandonTimer.unref) abandonTimer.unref();
    abandonTimers.set(workerId, abandonTimer);
  });

  manager.onConnect((workerId) => {
    const held = disconnectTimers.has(workerId) || abandonTimers.has(workerId);
    clearWorkerTimers(workerId);
    if (!held) return;
    const readopted: string[] = [];
    for (const [sessionId, session] of sessions.entries()) {
      if (session.workerId !== workerId) continue;
      if (session.detachedSinceMs !== undefined) readopted.push(sessionId);
      session.detachedSinceMs = undefined;
    }
    if (readopted.length === 0) {
      console.log(`[agent-remote] worker ${workerId} reconnected within grace; sessions continue`);
      return;
    }
    console.log(
      `[agent-remote] worker ${workerId} reconnected; re-adopting detached session(s) ${readopted.join(", ")} — ` +
        `their callbacks were never torn down, so streaming resumes`,
    );
    for (const sessionId of readopted) {
      const session = sessions.get(sessionId);
      if (session) report(sessionId, session, `Fleet worker ${workerId} reconnected; this session is live again.`);
    }
  });
}
