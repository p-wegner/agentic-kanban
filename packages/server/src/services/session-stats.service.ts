import type { Database } from "../db/index.js";
import { getSessionStatsByWorkspaceIds } from "../repositories/session-stats.repository.js";

/**
 * For a list of workspace IDs, query their latest sessions and return:
 * - contextTokens per workspace (contextTokens from session stats, falling back to input + cache-read)
 * - lastTool per workspace (from sessions.stats.lastTool — written by broadcast on session exit)
 */
export async function enrichWorkspacesWithSessionData(
  wsIds: string[],
  database: Database,
): Promise<{ contextTokensMap: Map<string, number>; lastToolMap: Map<string, string> }> {
  const contextTokensMap = new Map<string, number>();
  const lastToolMap = new Map<string, string>();

  if (wsIds.length === 0) return { contextTokensMap, lastToolMap };

  const sessRows = await getSessionStatsByWorkspaceIds(wsIds, database);

  const latestByWs = new Map<string, { id: string; stats: string | null }>();
  for (const s of sessRows) latestByWs.set(s.workspaceId, { id: s.id, stats: s.stats });

  for (const [wsId, sess] of latestByWs) {
    if (!sess.stats) continue;
    try {
      const p = JSON.parse(sess.stats) as Record<string, unknown>;
      const explicitContextTokens = (p.contextTokens as number) ?? 0;
      const tokens = explicitContextTokens || ((p.inputTokens as number) ?? 0) + ((p.cacheReadTokens as number) ?? 0);
      if (tokens) contextTokensMap.set(wsId, tokens);
      if (typeof p.lastTool === "string" && p.lastTool) lastToolMap.set(wsId, p.lastTool);
    } catch { /* ignore */ }
  }

  return { contextTokensMap, lastToolMap };
}
