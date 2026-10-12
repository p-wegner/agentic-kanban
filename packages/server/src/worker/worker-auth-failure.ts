/**
 * #1426: per-session watch for a dead claude login. A session whose output carried an auth
 * failure and which never started a tool call did nothing - the worker reports that as a launch
 * failure (so the board re-places it) instead of an exit the board would finalize as a failed build.
 */
import { AUTH_EXPIRED_PREFIX, AUTH_FAILURE_PATTERN } from "./worker-profiles.js";

type Send = (message: { type: "assign_failed"; sessionId: string; error: string }) => void;

export function createAuthFailureTracker(send: Send, onAuthFailure?: (profile: string | undefined) => void) {
  const failed = new Set<string>();
  const toolStarted = new Set<string>();
  const profiles = new Map<string, string | undefined>();
  return {
    begin(sessionId: string, profile: string | undefined): void {
      profiles.set(sessionId, profile?.trim() || undefined);
    },
    noteOutput(sessionId: string, type: "stdout" | "stderr", data: string): void {
      if (AUTH_FAILURE_PATTERN.test(data)) failed.add(sessionId);
      if (type === "stdout" && data.includes('"tool_use"')) toolStarted.add(sessionId);
    },
    /**
     * Forget the session. When it died of an auth failure before doing work: tell the attestor, drop the
     * workless checkout, answer the board with `assign_failed` so it re-places, and return true.
     */
    exit(sessionId: string, exitCode: number | null, cleanup?: () => Promise<void>): boolean {
      const dead = exitCode !== 0 && failed.has(sessionId) && !toolStarted.has(sessionId);
      const profile = profiles.get(sessionId);
      failed.delete(sessionId); toolStarted.delete(sessionId); profiles.delete(sessionId);
      if (!dead) return false;
      onAuthFailure?.(profile);
      if (cleanup) void cleanup().catch(() => {});
      const who = profile ? ` (${profile})` : "";
      send({
        type: "assign_failed",
        sessionId,
        error: `${AUTH_EXPIRED_PREFIX}${who}: the agent could not authenticate before doing any work - re-login or copy credentials on this worker`,
      });
      return true;
    },
  };
}
