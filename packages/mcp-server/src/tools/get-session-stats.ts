import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

interface SessionStats {
  sessionId: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  tokenUsage: TokenUsage | null;
  totalCostUsd: number | null;
  messageCount: number;
}

// Parse token usage and cost from session output messages.
// Claude's streaming JSON output includes result events with usage data.
function parseSessionStats(
  messages: Array<{ type: string | null; data: string | null; exitCode: string | null }>,
  session: { status: string | null; startedAt: string | null; endedAt: string | null },
): SessionStats {
  const stats: SessionStats = {
    sessionId: "",
    status: session.status ?? "unknown",
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    durationMs: null,
    tokenUsage: null,
    totalCostUsd: null,
    messageCount: messages.length,
  };

  // Calculate duration
  if (session.startedAt && session.endedAt) {
    stats.durationMs = new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime();
  }

  // Parse token usage from result events in the output
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;
  let totalCost = 0;
  let foundUsage = false;

  for (const msg of messages) {
    if (msg.type !== "stdout" || !msg.data) continue;

    // Try to parse JSON lines from the output
    for (const line of msg.data.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);

        // Handle Claude Code's result events
        if (parsed.type === "result" && parsed.usage) {
          const usage = parsed.usage;
          totalInput += usage.input_tokens ?? 0;
          totalOutput += usage.output_tokens ?? 0;
          totalCacheCreation += usage.cache_creation_input_tokens ?? 0;
          totalCacheRead += usage.cache_read_input_tokens ?? 0;
          if (parsed.cost_usd != null) totalCost += parsed.cost_usd;
          foundUsage = true;
        }
      } catch {
        // Not JSON — skip
      }
    }
  }

  if (foundUsage) {
    stats.tokenUsage = {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      totalTokens: totalInput + totalOutput,
      cacheCreationInputTokens: totalCacheCreation,
      cacheReadInputTokens: totalCacheRead,
    };
    stats.totalCostUsd = Math.round(totalCost * 10000) / 10000;
  }

  return stats;
}

export function registerGetSessionStats(server: McpServer) {
  server.tool(
    "get_session_stats",
    "Get token usage, cost, duration, and status stats for a session. Parses result events from persisted session output.",
    {
      sessionId: z.string().describe("The session ID to get stats for"),
    },
    async ({ sessionId }) => {
      const sessionRows = await db.select().from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId))
        .limit(1);
      if (sessionRows.length === 0) {
        return { content: [{ type: "text" as const, text: `Session ${sessionId} not found` }] };
      }

      const session = sessionRows[0];
      const rows = await db.select().from(schema.sessionMessages)
        .where(eq(schema.sessionMessages.sessionId, sessionId))
        .orderBy(schema.sessionMessages.id);

      const messages = rows.map(r => ({
        type: r.type,
        data: r.data,
        exitCode: r.exitCode,
      }));

      const stats = parseSessionStats(messages, session);
      stats.sessionId = sessionId;

      return {
        content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }],
      };
    },
  );
}
