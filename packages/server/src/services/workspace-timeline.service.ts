import { sessions, workspaces, sessionMessages } from "@agentic-kanban/shared/schema";
import { eq, desc, and, inArray } from "drizzle-orm";
import type { Database } from "../db/index.js";
import type { WorkspaceTimelineEvent, WorkspaceTimelineResponse, WorkspaceTimelineEventType } from "@agentic-kanban/shared";

function isZeroOutputSession(session: { startedAt: string; endedAt: string | null; stats: string | null }): boolean {
  if (!session.endedAt) return false;
  const durationMs = new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime();
  if (durationMs <= 1000) return true;
  if (session.stats) {
    try {
      const s = JSON.parse(session.stats) as Record<string, unknown>;
      if ((s.inputTokens === 0 || s.inputTokens == null) && (s.outputTokens === 0 || s.outputTokens == null)) return true;
      if (s.launchFailure === true) return true;
    } catch { /* ignore */ }
  }
  return false;
}

function parseStats(stats: string | null): { inputTokens?: number; outputTokens?: number } | null {
  if (!stats) return null;
  try {
    return JSON.parse(stats) as Record<string, number>;
  } catch {
    return null;
  }
}

function extractMessageText(data: string | null): string | null {
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (typeof parsed.text === "string") return parsed.text.slice(0, 500).trim() || null;
    if (typeof parsed.message === "string") return parsed.message.slice(0, 500).trim() || null;
    if (Array.isArray(parsed.content)) {
      const textBlock = (parsed.content as Array<{ type?: string; text?: string }>).find(b => b.type === "text");
      if (textBlock?.text) return textBlock.text.slice(0, 500).trim() || null;
    }
  } catch { /* ignore */ }
  return data.slice(0, 500).trim() || null;
}

async function getLastAssistantMessagesBatch(
  database: Database,
  sessionIds: string[],
): Promise<Map<string, string | null>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await database
    .select({ sessionId: sessionMessages.sessionId, data: sessionMessages.data, createdAt: sessionMessages.createdAt })
    .from(sessionMessages)
    .where(and(
      inArray(sessionMessages.sessionId, sessionIds),
      eq(sessionMessages.type, "assistant"),
    ))
    .orderBy(desc(sessionMessages.createdAt));

  // Pick the most recent message per session (rows ordered desc, so first seen = latest)
  const result = new Map<string, string | null>();
  for (const row of rows) {
    if (!result.has(row.sessionId)) {
      result.set(row.sessionId, extractMessageText(row.data));
    }
  }
  for (const id of sessionIds) {
    if (!result.has(id)) result.set(id, null);
  }
  return result;
}

export async function getWorkspaceTimeline(
  workspaceId: string,
  database: Database,
): Promise<WorkspaceTimelineResponse> {
  const wsRows = await database
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (wsRows.length === 0) throw new Error(`Workspace ${workspaceId} not found`);
  const ws = wsRows[0];

  const sessionRows = await database
    .select()
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId))
    .orderBy(desc(sessions.startedAt));

  const events: WorkspaceTimelineEvent[] = [];
  let idCounter = 0;
  function nextId() { return `evt-${++idCounter}`; }

  // Workspace created
  events.push({
    id: nextId(),
    type: "workspace_created",
    timestamp: ws.createdAt,
    label: `Workspace created on branch \`${ws.branch}\``,
    severity: "info",
  });

  // Setup events
  if (ws.latestSetupStartedAt) {
    events.push({
      id: nextId(),
      type: "setup_started",
      timestamp: ws.latestSetupStartedAt,
      label: "Setup script started",
      severity: "info",
    });

    if (ws.latestSetupEndedAt) {
      const failed = ws.latestSetupState === "failed";
      events.push({
        id: nextId(),
        type: failed ? "setup_failed" : "setup_completed",
        timestamp: ws.latestSetupEndedAt,
        label: failed
          ? `Setup script failed (exit ${ws.latestSetupExitCode ?? "?"})`
          : "Setup script completed",
        detail: failed ? (ws.latestSetupStderrTail?.slice(-300).trim() || null) : null,
        severity: failed ? "error" : "success",
      });
    }
  }

  // Pre-determine which ended sessions need last-assistant-message (non-completed ones)
  const sessionsNeedingMessage = sessionRows.filter(s =>
    s.endedAt && (isZeroOutputSession(s) || s.status === "stopped")
  );
  const lastMessages = await getLastAssistantMessagesBatch(
    database,
    sessionsNeedingMessage.map(s => s.id),
  );

  // Session events (most recent first in DB, but we'll sort all at the end)
  for (const session of sessionRows) {
    const stats = parseStats(session.stats);
    const tokenCounts = (stats?.inputTokens != null || stats?.outputTokens != null)
      ? { inputTokens: (stats?.inputTokens ?? 0) as number, outputTokens: (stats?.outputTokens ?? 0) as number }
      : null;

    // Session launched
    const triggerLabel = session.triggerType ?? null;
    events.push({
      id: nextId(),
      type: "session_launched",
      timestamp: session.startedAt,
      label: triggerLabel
        ? `Session launched (${triggerLabel})`
        : "Session launched",
      severity: "info",
      sessionId: session.id,
      triggerType: triggerLabel,
    });

    // Session ended
    if (session.endedAt) {
      const zerOut = isZeroOutputSession(session);
      const stopped = session.status === "stopped";
      const nonZeroExit = session.exitCode !== null && session.exitCode !== "0";

      let eventType: WorkspaceTimelineEventType = "session_completed";
      let label = "Session completed";
      let severity: "info" | "warning" | "error" | "success" = "success";
      let detail: string | null = null;

      if (zerOut) {
        eventType = "session_zero_output";
        label = "Session exited with zero output (launch failure)";
        severity = "error";
      } else if (stopped && nonZeroExit) {
        eventType = "session_stopped";
        label = `Session stopped (exit code ${session.exitCode})`;
        severity = "error";
      } else if (stopped) {
        eventType = "session_stopped";
        label = "Session stopped";
        severity = "warning";
      }

      if (eventType !== "session_completed") {
        detail = lastMessages.get(session.id) ?? null;
      }

      events.push({
        id: nextId(),
        type: eventType,
        timestamp: session.endedAt,
        label,
        detail,
        severity,
        sessionId: session.id,
        triggerType: triggerLabel,
        tokenCounts,
        exitCode: session.exitCode,
      });
    }
  }

  // ready_for_merge
  if (ws.readyForMerge) {
    events.push({
      id: nextId(),
      type: "ready_for_merge",
      timestamp: ws.updatedAt,
      label: "Marked ready for merge",
      severity: "success",
    });
  }

  // Workspace merged
  if (ws.mergedAt) {
    events.push({
      id: nextId(),
      type: "workspace_merged",
      timestamp: ws.mergedAt,
      label: "Workspace merged",
      severity: "success",
    });
  }

  // Workspace closed (without merge)
  if (ws.closedAt && !ws.mergedAt) {
    events.push({
      id: nextId(),
      type: "workspace_closed",
      timestamp: ws.closedAt,
      label: "Workspace closed",
      severity: "info",
    });
  }

  // Sort chronologically ascending (oldest first)
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    workspaceId,
    generatedAt: new Date().toISOString(),
    events,
  };
}
