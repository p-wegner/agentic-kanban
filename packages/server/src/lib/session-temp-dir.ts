// A private temp dir per agent session (#1391). Two builders on one machine used to share
// the OS temp dir, so `/tmp/msg.txt` written by one was overwritten by the other and a commit
// carried the wrong ticket's message. Pointing TMPDIR/TMP/TEMP at a per-session directory
// makes every `$TMPDIR/...`, `mktemp` and tool-default temp path session-private.
//
// Built on `createManagedTempDir`, so it lives in the `kanban-` namespace, carries an owner
// pid marker, and a crashed session's directory is recoverable by the stale-temp sweep.

import { createManagedTempDir } from "@agentic-kanban/shared/lib/temp-dir";

export const SESSION_TEMP_PREFIX = "kanban-session-tmp-";

export interface SessionTempDir {
  readonly path: string;
  /** The env vars that make child processes use this directory as their temp dir. */
  readonly env: Record<string, string>;
  /** Remove the directory; idempotent, never throws. */
  dispose(): boolean;
}

export function sessionTempEnv(dir: string): Record<string, string> {
  return { TMPDIR: dir, TMP: dir, TEMP: dir };
}

/** Create the per-session temp dir. Returns null when it cannot be created (never blocks a launch). */
export function createSessionTempDir(sessionId: string): SessionTempDir | null {
  try {
    const safeId = sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
    const dir = createManagedTempDir(`${SESSION_TEMP_PREFIX}${safeId}-`);
    return { path: dir.path, env: sessionTempEnv(dir.path), dispose: () => dir.dispose() };
  } catch (err) {
    console.warn(`[session-temp] could not create a per-session temp dir for ${sessionId}:`, err);
    return null;
  }
}

// Worker-side registry: one live temp dir per session id, released on spawn failure or exit.
const live = new Map<string, SessionTempDir>();

/** Create and register the session's temp dir; returns its env (empty when it cannot be created). */
export function startSessionTemp(sessionId: string): Record<string, string> {
  const dir = createSessionTempDir(sessionId);
  if (dir) live.set(sessionId, dir);
  return dir?.env ?? {};
}

export function releaseSessionTemp(sessionId: string): void {
  live.get(sessionId)?.dispose();
  live.delete(sessionId);
}
