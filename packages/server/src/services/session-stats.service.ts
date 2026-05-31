import { sessions, sessionMessages } from "@agentic-kanban/shared/schema";
import { inArray, desc } from "drizzle-orm";
import type { Database } from "../db/index.js";

/**
 * For a list of workspace IDs, query their latest sessions and return:
 * - contextTokens per workspace (contextTokens from session stats, falling back to input + cache-read)
 * - lastTool per workspace (name of last tool_use block in session messages)
 */
export async function enrichWorkspacesWithSessionData(
  wsIds: string[],
  database: Database,
): Promise<{ contextTokensMap: Map<string, number>; lastToolMap: Map<string, string> }> {
  const contextTokensMap = new Map<string, number>();
  const lastToolMap = new Map<string, string>();

  if (wsIds.length === 0) return { contextTokensMap, lastToolMap };

  const sessRows = await database
    .select({ id: sessions.id, workspaceId: sessions.workspaceId, stats: sessions.stats })
    .from(sessions)
    .where(inArray(sessions.workspaceId, wsIds))
    .orderBy(sessions.startedAt);

  const latestByWs = new Map<string, { id: string; stats: string | null }>();
  for (const s of sessRows) latestByWs.set(s.workspaceId, { id: s.id, stats: s.stats });

  for (const [wsId, sess] of latestByWs) {
    if (sess.stats) {
      try {
        const p = JSON.parse(sess.stats) as Record<string, unknown>;
        const explicitContextTokens = (p.contextTokens as number) ?? 0;
        const tokens = explicitContextTokens || ((p.inputTokens as number) ?? 0) + ((p.cacheReadTokens as number) ?? 0);
        if (tokens) contextTokensMap.set(wsId, tokens);
      } catch { /* ignore */ }
    }
  }

  const sessIds = [...latestByWs.values()].map(s => s.id);
  if (sessIds.length > 0) {
    const msgRows = await database
      .select({ sessionId: sessionMessages.sessionId, data: sessionMessages.data })
      .from(sessionMessages)
      .where(inArray(sessionMessages.sessionId, sessIds))
      .orderBy(desc(sessionMessages.id));

    const sessionToWs = new Map<string, string>();
    for (const [wsId, sess] of latestByWs) sessionToWs.set(sess.id, wsId);

    for (const msg of msgRows) {
      const wsId = sessionToWs.get(msg.sessionId);
      if (!wsId || lastToolMap.has(wsId) || !msg.data) continue;
      try {
        const obj = JSON.parse(msg.data) as Record<string, unknown>;
        if (obj.type === "assistant") {
          const content = (obj.message as { content?: unknown[] })?.content ?? [];
          for (const block of content as { type: string; name?: string }[]) {
            if (block.type === "tool_use" && block.name) {
              lastToolMap.set(wsId, block.name);
              break;
            }
          }
        }
        // Copilot stream: tool names are in assistant.message data.toolRequests
        if (obj.type === "assistant.message" && !lastToolMap.has(wsId)) {
          const data = obj.data as Record<string, unknown> | undefined;
          const toolRequests = Array.isArray(data?.toolRequests) ? data!.toolRequests : [];
          for (const tr of toolRequests as { name?: string }[]) {
            if (tr.name) {
              lastToolMap.set(wsId, tr.name);
              break;
            }
          }
        }
      } catch { /* ignore */ }
    }
  }

  return { contextTokensMap, lastToolMap };
}
