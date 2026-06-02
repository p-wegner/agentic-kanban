import { sessions, workspaces, sessionMessages } from "@agentic-kanban/shared/schema";
import { eq, desc, and } from "drizzle-orm";
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

async function getLastAssistantMessage(database: Database, sessionId: string): Promise<string | null> {
  const rows = await database
    .select({ type: sessionMessages.type, data: sessionMessages.data })
    .from(sessionMessages)
    .where(and(
      eq(sessionMessages.sessionId, sessionId),
      eq(sessionMessages.type, "assistant"),
    ))
    .orderBy(desc(sessionMessages.createdAt))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0];
  if (!row.data) return null;
  try {
    const parsed = JSON.parse(row.data) as Record<string, unknown>;
    if (typeof parsed.text === "string") return parsed.text.slice(0, 500).trim() || null;
    if (typeof parsed.message === "string") return parsed.message.slice(0, 500).trim() || null;
    if (Array.isArray(parsed.content)) {
      const textBlock = (parsed.content as Array<{ type?: string; text?: string }>).find(b => b.type === "text");
      if (textBlock?.text) return textBlock.text.slice(0, 500).trim() || null;
    }
  } catch { /* ignore */ }
  if (typeof row.data === "string") return row.data.slice(0, 500).trim() || null;
  return null;
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

      // Fetch last assistant message for stopped/failed sessions
      if (eventType !== "session_completed") {
        detail = await getLastAssistantMessage(database, session.id);
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
