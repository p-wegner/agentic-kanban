/**
 * Butler session registry: the `sessions` map, listener bookkeeping, and the
 * read-only lookups the rest of the service and its consumers use to inspect a
 * session without touching its lifecycle (#465 decomposition).
 */
import type { ButlerCommand, ButlerEvent, ButlerSession, ButlerSessionState, ButlerTurn, Listener } from "./types.js";

/**
 * Sessions keyed by a composite of project + butler. The default butler keeps the
 * plain projectId as its key so existing in-memory/resume behavior is unchanged;
 * named butlers use `${projectId}::${butlerId}`.
 */
export const sessions = new Map<string, ButlerSession>();

/** Composite session/listener key. Default butler → plain projectId (backward compat). */
export function butlerSessionKey(projectId: string, butlerId: string = "default"): string {
  return butlerId && butlerId !== "default" ? `${projectId}::${butlerId}` : projectId;
}

/**
 * SSE listeners keyed by the same composite key as sessions, kept SEPARATE from the
 * session lifecycle. A stream connects once and must keep receiving events across
 * "clear context" and profile switches, which stop+recreate the underlying session.
 * If listeners lived on the session, reconnecting the stream while no session exists
 * (the gap between stop and the next message) would silently drop the listener and
 * the stream would go dead. Keeping them here means a stream stays attached regardless.
 */
const listenersByKey = new Map<string, Set<Listener>>();

/**
 * The subset of {@link listenersByKey} that is a HUMAN — i.e. the SSE stream behind an
 * open Butler chat tab. Kept separate because "is a listener attached" is not the same
 * question as "can somebody answer" (#461): `POST /:id/butler/ask` and `startSession`
 * subscribe internal listeners too, and counting those would make the synchronous
 * CLI/MCP door — where the caller is blocked waiting for ONE answer and no UI exists —
 * look interactive, park the question, and hang it for the full timeout.
 * Non-interactive is the default; only the stream route opts in.
 */
const interactiveListenersByKey = new Map<string, Set<Listener>>();

export function broadcast(s: ButlerSession, e: ButlerEvent): void {
  const ls = listenersByKey.get(s.key);
  if (!ls) return;
  for (const l of ls) {
    try {
      l(e);
    } catch (err) {
      console.error(`[butler-sdk] listener error: project=${s.projectId} butler=${s.butlerId}`, err);
    }
  }
}

/** True when at least one HUMAN SSE stream (an open Butler chat tab) is attached. */
export function hasInteractiveButlerListener(projectId: string, butlerId: string = "default"): boolean {
  return (interactiveListenersByKey.get(butlerSessionKey(projectId, butlerId))?.size ?? 0) > 0;
}

export function getButlerSession(projectId: string, butlerId: string = "default"): ButlerSessionState {
  const s = sessions.get(butlerSessionKey(projectId, butlerId));
  return { butlerId, backend: s?.backend ?? "claude", sessionId: s?.sessionId, active: !!s, busy: s?.busy ?? false, contextTokens: s?.contextTokens ?? 0, model: s?.model, contextWindow: s?.contextWindow, mcpConnected: s?.mcpConnected, claudeProfile: s?.claudeProfile };
}

/** Runtime state of every warm butler session for a project (for the butler switcher). */
export function listProjectButlerStates(projectId: string): ButlerSessionState[] {
  const out: ButlerSessionState[] = [];
  for (const s of sessions.values()) {
    if (s.projectId !== projectId) continue;
    out.push({ butlerId: s.butlerId, backend: s.backend, sessionId: s.sessionId, active: true, busy: s.busy, contextTokens: s.contextTokens, model: s.model, contextWindow: s.contextWindow, mcpConnected: s.mcpConnected, claudeProfile: s.claudeProfile });
  }
  return out;
}

/** Slash commands the active session reported as available (empty if none/not yet fetched). */
export function getButlerCommands(projectId: string, butlerId: string = "default"): ButlerCommand[] {
  return sessions.get(butlerSessionKey(projectId, butlerId))?.commands ?? [];
}

/** Conversation history for the active session (empty if none) — replayed by the UI on reload. */
export function getButlerTranscript(projectId: string, butlerId: string = "default"): ButlerTurn[] {
  return sessions.get(butlerSessionKey(projectId, butlerId))?.transcript ?? [];
}

export function subscribeButler(
  projectId: string,
  listener: Listener,
  butlerId: string = "default",
  /** True only for a stream backed by a human UI — see {@link interactiveListenersByKey}. */
  opts?: { interactive?: boolean },
): () => void {
  const key = butlerSessionKey(projectId, butlerId);
  let ls = listenersByKey.get(key);
  if (!ls) {
    ls = new Set();
    listenersByKey.set(key, ls);
  }
  ls.add(listener);
  if (opts?.interactive) {
    let interactive = interactiveListenersByKey.get(key);
    if (!interactive) {
      interactive = new Set();
      interactiveListenersByKey.set(key, interactive);
    }
    interactive.add(listener);
  }
  // Replay current state so a freshly-connected stream is immediately in sync.
  const s = sessions.get(key);
  if (s) {
    if (s.sessionId) listener({ type: "session", sessionId: s.sessionId });
    if (s.model || s.contextWindow || s.mcpConnected !== undefined) listener({ type: "meta", model: s.model, contextWindow: s.contextWindow, mcpConnected: s.mcpConnected });
    if (s.contextTokens) listener({ type: "usage", contextTokens: s.contextTokens });
  }
  return () => {
    const interactive = interactiveListenersByKey.get(key);
    if (interactive) {
      interactive.delete(listener);
      if (interactive.size === 0) interactiveListenersByKey.delete(key);
    }
    const set = listenersByKey.get(key);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) listenersByKey.delete(key);
  };
}
