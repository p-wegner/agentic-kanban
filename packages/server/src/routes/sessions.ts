import { Hono } from "hono";
import { db } from "../db/index.js";
import { sessionMessages, sessions } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";

export function createSessionsRoute(database: Database = db) {
  const router = new Hono();

  // GET /api/sessions/:sessionId/output
  router.get("/:sessionId/output", async (c) => {
    const sessionId = c.req.param("sessionId");

    // Check session exists
    const sessionRows = await database
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (sessionRows.length === 0) {
      return c.json({ error: "Session not found" }, 404);
    }

    const rows = await database
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(sessionMessages.id);

    const messages: AgentOutputMessage[] = rows.map((row) => ({
      type: row.type as "stdout" | "stderr" | "exit",
      sessionId: row.sessionId,
      data: row.data ?? undefined,
      exitCode: row.exitCode != null ? Number(row.exitCode) : undefined,
    }));

    return c.json(messages);
  });

  // GET /api/sessions/:sessionId/stats
  router.get("/:sessionId/stats", async (c) => {
    const sessionId = c.req.param("sessionId");

    const sessionRows = await database
      .select({ stats: sessions.stats })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (sessionRows.length === 0) {
      return c.json({ error: "Session not found" }, 404);
    }

    const statsStr = sessionRows[0].stats;
    if (!statsStr) {
      return c.json({ error: "No stats available" }, 404);
    }

    try {
      return c.json(JSON.parse(statsStr));
    } catch {
      return c.json({ error: "Invalid stats data" }, 500);
    }
  });

  // GET /api/sessions/:sessionId/summary
  router.get("/:sessionId/summary", async (c) => {
    const sessionId = c.req.param("sessionId");

    const sessionRows = await database
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (sessionRows.length === 0) {
      return c.json({ error: "Session not found" }, 404);
    }

    const session = sessionRows[0];

    // Fetch session messages
    const rows = await database
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(sessionMessages.id);

    // Parse stats
    let stats: Record<string, unknown> | null = null;
    if (session.stats) {
      try { stats = JSON.parse(session.stats); } catch { /* ignore */ }
    }

    // Compute duration
    let duration: string | null = null;
    if (session.endedAt && session.startedAt) {
      const diffMs = new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime();
      duration = formatDurationStr(diffMs);
    }

    // Parse stream events from message data
    const summary = parseSessionSummary(rows, sessionId);

    // Fast-path: pull agentSummary from stored stats if available (already parsed above)
    if (!summary.agentSummary && stats && typeof stats.agentSummary === "string") {
      summary.agentSummary = stats.agentSummary;
    }

    return c.json({
      sessionId,
      duration,
      stats,
      status: session.status,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      ...summary,
    });
  });

  return router;
}

function formatDurationStr(diffMs: number): string {
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

interface SessionSummary {
  overview: string;
  agentSummary: string | null;
  actions: Array<{ type: string; files?: string[]; commands?: string[] }>;
  keyExcerpts: string[];
  errors: string[];
  filesRead: string[];
  filesEdited: string[];
  filesWritten: string[];
  commandsRun: string[];
  model: string;
}

function parseSessionSummary(
  rows: Array<{ type: string; data: string | null }>,
  _sessionId: string,
): SessionSummary {
  const toolNameMap = new Map<string, string>();

  const filesRead = new Set<string>();
  const filesEdited = new Set<string>();
  const filesWritten = new Set<string>();
  const commandsRun: string[] = [];
  const keyExcerpts: string[] = [];
  const errors: string[] = [];
  let model = "";
  let initFound = false;
  let agentSummary: string | null = null;

  for (const row of rows) {
    if (row.type !== "stdout" || !row.data) continue;

    // Each data field may contain multiple JSONL lines
    const lines = row.data.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const type = obj.type as string;

      // Parse init event
      if (type === "system" && obj.subtype === "init") {
        initFound = true;
        model = (obj.model as string) || "unknown";
        continue;
      }

      // Parse assistant messages
      if (type === "assistant") {
        const message = obj.message as Record<string, unknown> | undefined;
        const content = (message?.content as Array<Record<string, unknown>>) || [];
        const msgModel = (message?.model as string) || "";
        if (msgModel) model = msgModel;

        for (const block of content) {
          if (block.type === "text") {
            const text = (block.text as string) || "";
            if (text && keyExcerpts.length < 10) {
              // Only keep first 300 chars of each excerpt
              keyExcerpts.push(text.length > 300 ? text.slice(0, 300) + "..." : text);
            }
          } else if (block.type === "tool_use") {
            const toolUseId = (block.id as string) || "";
            const toolName = (block.name as string) || "unknown";
            if (toolUseId) toolNameMap.set(toolUseId, toolName);
            const input = block.input as Record<string, unknown> | undefined;

            if (toolName === "Read" && input?.file_path) {
              filesRead.add(input.file_path as string);
            } else if (toolName === "Edit" && input?.file_path) {
              filesEdited.add(input.file_path as string);
            } else if (toolName === "Write" && input?.file_path) {
              filesWritten.add(input.file_path as string);
            } else if (toolName === "Bash" && input?.command) {
              const cmd = (input.command as string).slice(0, 200);
              commandsRun.push(cmd);
            }
          }
        }
        continue;
      }

      // Parse user messages (tool results)
      if (type === "user") {
        const message = obj.message as Record<string, unknown> | undefined;
        const content = (message?.content as Array<Record<string, unknown>>) || [];

        for (const block of content) {
          if (block.type === "tool_result" && (block.is_error as boolean)) {
            const toolUseId = (block.tool_use_id as string) || "";
            const toolName = toolUseId ? (toolNameMap.get(toolUseId) || "unknown") : "unknown";
            const rawContent = block.content;
            const output = typeof rawContent === "string"
              ? rawContent
              : JSON.stringify(rawContent);
            if (errors.length < 10) {
              errors.push(`${toolName}: ${output.length > 200 ? output.slice(0, 200) + "..." : output}`);
            }
          }
        }
        continue;
      }

      // Parse result event — capture full agent summary, don't truncate
      if (type === "result") {
        const resultText = (obj.result as string) || "";
        if (resultText) agentSummary = resultText;
        continue;
      }
    }
  }

  // Build actions summary
  const actions: Array<{ type: string; files?: string[]; commands?: string[] }> = [];
  if (filesRead.size > 0) actions.push({ type: "read", files: [...filesRead] });
  if (filesEdited.size > 0) actions.push({ type: "edit", files: [...filesEdited] });
  if (filesWritten.size > 0) actions.push({ type: "write", files: [...filesWritten] });
  if (commandsRun.length > 0) actions.push({ type: "command", commands: commandsRun });

  // Build overview
  const parts: string[] = [];
  if (initFound) parts.push(`Agent session using ${model}`);
  if (filesRead.size > 0) parts.push(`read ${filesRead.size} file${filesRead.size !== 1 ? "s" : ""}`);
  if (filesEdited.size > 0) parts.push(`edited ${filesEdited.size} file${filesEdited.size !== 1 ? "s" : ""}`);
  if (filesWritten.size > 0) parts.push(`wrote ${filesWritten.size} file${filesWritten.size !== 1 ? "s" : ""}`);
  if (commandsRun.length > 0) parts.push(`ran ${commandsRun.length} command${commandsRun.length !== 1 ? "s" : ""}`);
  const overview = parts.length > 0 ? parts.join(", ") : "No activity recorded";

  return {
    overview,
    agentSummary,
    actions,
    keyExcerpts,
    errors,
    filesRead: [...filesRead],
    filesEdited: [...filesEdited],
    filesWritten: [...filesWritten],
    commandsRun,
    model,
  };
}
