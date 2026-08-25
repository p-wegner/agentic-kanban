// Pure helpers extracted from workspace-summary.service's attachSessionData phase.
// Kept side-effect-free (no db / no fs) so they are a directly-unit-testable seam:
// session selection and stats parsing are pure transforms, while the file/DB
// message scan stays in the service where the I/O lives.

/** The minimal session shape the summary cares about, projected from a session row.
 * `stats` is deliberately absent (G9): the repository query no longer ships every
 * historical session's stats blob — the service fetches stats for just the winner
 * rows afterwards (getSessionStatsByIds). */
export interface LatestSession {
  id: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  triggerType: string | null;
  /** The fleet worker this session ran on, if any (#898). Null for a board-host session. */
  workerId: string | null;
}

/**
 * `workerId` is optional on the INPUT row but required on the projected `LatestSession`:
 * a board-host session simply has no worker column value, while a projection that forgot
 * to carry it would silently make every remote placement look local (#898).
 */
interface SessionRow extends Omit<LatestSession, "workerId"> {
  workspaceId: string;
  workerId?: string | null;
}

/**
 * Pick the latest session per workspace, preferring real (non-noise) sessions and
 * falling back to a noise session only when a workspace has no real session.
 *
 * `isNoise` is injected (rather than imported) so this stays a leaf with no
 * dependency on the analytics-filter service — caller passes `isAnalyticsNoise`.
 *
 * The input is assumed already ordered so that the last row seen for a workspace
 * is the one to keep (the repository query orders by recency); this mirrors the
 * previous in-place Map overwrite semantics exactly.
 */
export function selectLatestSessionsByWorkspace(
  sessionRows: SessionRow[],
  isNoise: (s: { triggerType?: string | null }) => boolean,
): Map<string, LatestSession> {
  const latestByWs = new Map<string, LatestSession>();
  const latestNoiseByWs = new Map<string, LatestSession>();
  for (const s of sessionRows) {
    const entry: LatestSession = {
      id: s.id,
      status: s.status,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      triggerType: s.triggerType ?? null,
      workerId: s.workerId ?? null,
    };
    if (isNoise(s)) {
      latestNoiseByWs.set(s.workspaceId, entry);
    } else {
      latestByWs.set(s.workspaceId, entry);
    }
  }
  for (const [wsId, noiseSession] of latestNoiseByWs) {
    if (!latestByWs.has(wsId)) latestByWs.set(wsId, noiseSession);
  }
  return latestByWs;
}

/**
 * Derive the context-token count from a session's serialized `stats` JSON blob.
 * Prefers an explicit `contextTokens`, else the sum of input + cache-read tokens,
 * else null. Returns null on absent/malformed JSON (never throws).
 */
export function parseContextTokensFromStats(stats: string | null): number | null {
  if (!stats) return null;
  try {
    const p: unknown = JSON.parse(stats);
    if (p === null || typeof p !== "object") return null;
    const typed = p as Record<string, unknown>;
    const explicitContextTokens = (typed.contextTokens as number) ?? 0;
    const inputTokens = (typed.inputTokens as number) ?? 0;
    const cachedTokens = (typed.cacheReadTokens as number) ?? 0;
    return explicitContextTokens || inputTokens + cachedTokens || null;
  } catch {
    return null;
  }
}
