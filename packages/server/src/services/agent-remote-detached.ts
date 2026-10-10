// Detached-session bookkeeping for the remote agent service (#1317). Its own module because
// `createRemoteAgentService` is under a shrink-only function-size ratchet (#800).
import type { DetachedRemoteSession, RemoteSession } from "./agent-remote.types.js";

/**
 * Sessions held because their worker is unreachable. The abandon timer runs from the
 * DISCONNECT and a session is detached `graceMs` after it, so the deadline is derived.
 */
export function listDetachedSessions(
  sessions: Map<string, RemoteSession>,
  graceMs: number,
  abandonMs: number,
): DetachedRemoteSession[] {
  const out: DetachedRemoteSession[] = [];
  for (const [sessionId, s] of sessions) {
    if (s.detachedSinceMs === undefined) continue;
    out.push({ sessionId, workerId: s.workerId, detachedSinceMs: s.detachedSinceMs, abandonAtMs: s.detachedSinceMs - graceMs + abandonMs });
  }
  return out;
}
