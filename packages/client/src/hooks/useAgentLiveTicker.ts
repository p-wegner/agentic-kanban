import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentOutputMessage, StatusWithIssues } from "@agentic-kanban/shared";
import { apiFetchConditional } from "../lib/api.js";
import { usePoll } from "./usePoll.js";

const POLL_INTERVAL_MS = 5000;
const MAX_TAIL = 60;
/** The ticker shows only the last 1-2 lines — a small server-side tail read is plenty. */
const OUTPUT_TAIL_BYTES = 64 * 1024;

export interface TickerEntry {
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  workspaceId: string;
  workspaceStatus: string;
  sessionId: string | null;
  /** Latest 1-2 lines of agent output */
  lines: string[];
  lastUpdated: number;
}

function extractLines(messages: AgentOutputMessage[]): string[] {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === "exit") continue;
    const raw = (msg.data ?? "").replace(/\x1b\[[0-9;]*[mGKHFJ]/g, "").trim();
    if (!raw) continue;
    const msgLines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    out.unshift(...msgLines.slice(-2));
    if (out.length >= 2) break;
  }
  return out.slice(-2);
}

function getActiveWorkspaces(columns: StatusWithIssues[]) {
  const result: Array<{
    issueId: string;
    issueNumber: number | null;
    issueTitle: string;
    workspaceId: string;
    workspaceStatus: string;
  }> = [];
  for (const col of columns) {
    for (const issue of col.issues) {
      const ws = issue.workspaceSummary?.main;
      if (!ws || (ws.status !== "active" && ws.status !== "fixing")) continue;
      result.push({
        issueId: issue.id,
        issueNumber: issue.issueNumber ?? null,
        issueTitle: issue.title,
        workspaceId: ws.id,
        workspaceStatus: ws.status,
      });
    }
  }
  return result;
}

export function useAgentLiveTicker(
  columns: StatusWithIssues[],
  liveActivity: Record<string, string>,
  enabled: boolean,
) {
  const [entries, setEntries] = useState<TickerEntry[]>([]);
  const etagsRef = useRef<Record<string, string>>({});
  const sessionIdCacheRef = useRef<Record<string, string>>({});
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const liveActivityRef = useRef(liveActivity);
  liveActivityRef.current = liveActivity;

  const fetchSessionId = useCallback(async (workspaceId: string): Promise<string | null> => {
    if (sessionIdCacheRef.current[workspaceId]) return sessionIdCacheRef.current[workspaceId];
    try {
      const sessions = await fetch(`/api/workspaces/${workspaceId}/sessions`)
        .then((r) => r.json() as Promise<Array<{ id: string; status: string; startedAt: string }>>);
      const running = sessions.find((s) => s.status === "running");
      const latest = running ?? sessions.sort((a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
      )[0];
      if (latest) {
        sessionIdCacheRef.current[workspaceId] = latest.id;
        return latest.id;
      }
    } catch { /* ignore */ }
    return null;
  }, []);

  const pollOutputForWorkspace = useCallback(async (
    sessionId: string,
  ): Promise<string[] | null> => {
    try {
      const result = await apiFetchConditional<AgentOutputMessage[]>(
        `/api/sessions/${sessionId}/output?tail=${OUTPUT_TAIL_BYTES}`,
        etagsRef.current[sessionId],
      );
      if (result.kind === "not-modified") return null;
      if (result.etag) etagsRef.current[sessionId] = result.etag;
      return extractLines(result.data.slice(-MAX_TAIL));
    } catch {
      // A ticker poll is decoration — a failed fetch must not surface as an error.
      // This swallow was previously implicit (`if (!res.ok) return null`), which made a
      // server error indistinguishable from a 304; it is now explicit and deliberate.
      return null;
    }
  }, []);

  const refresh = useCallback(async (cols: StatusWithIssues[], activity: Record<string, string>) => {
    if (!enabledRef.current) return;
    const active = getActiveWorkspaces(cols);
    if (active.length === 0) {
      setEntries([]);
      return;
    }

    const updated = await Promise.all(
      active.map(async (ws) => {
        // Live activity from board events is authoritative when present
        const liveText = activity[ws.issueId];
        if (liveText) {
          return {
            ...ws,
            sessionId: sessionIdCacheRef.current[ws.workspaceId] ?? null,
            lines: [liveText],
            lastUpdated: Date.now(),
          } satisfies TickerEntry;
        }

        // Fall back to polling session output
        const sessionId = await fetchSessionId(ws.workspaceId);
        if (!sessionId) {
          return {
            ...ws,
            sessionId: null,
            lines: [],
            lastUpdated: Date.now(),
          } satisfies TickerEntry;
        }

        try {
          const lines = await pollOutputForWorkspace(sessionId);
          return {
            ...ws,
            sessionId,
            lines: lines ?? [],
            lastUpdated: Date.now(),
          } satisfies TickerEntry;
        } catch {
          return {
            ...ws,
            sessionId,
            lines: [],
            lastUpdated: Date.now(),
          } satisfies TickerEntry;
        }
      })
    );

    setEntries(updated);
  }, [fetchSessionId, pollOutputForWorkspace]);

  // Kick off a poll when live activity changes (board event arrived)
  useEffect(() => {
    if (!enabled) return;
    void refresh(columns, liveActivity);
  }, [liveActivity, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Periodic poll so ticker stays fresh even without board events.
  // columnsRef/liveActivityRef keep interval stable across board updates.
  useEffect(() => {
    if (!enabled) {
      setEntries([]);
      return;
    }
  }, [enabled, refresh]);

  // #518: through the shared scheduler — a raw setInterval phase-aligns with the other
  // pollers at mount and keeps ticking in a hidden tab.
  usePoll(() => void refresh(columnsRef.current, liveActivityRef.current), POLL_INTERVAL_MS, enabled);

  // Clear session ID cache for no-longer-active workspaces
  useEffect(() => {
    const activeIds = new Set(getActiveWorkspaces(columns).map((a) => a.workspaceId));
    for (const key of Object.keys(sessionIdCacheRef.current)) {
      if (!activeIds.has(key)) {
        const cachedSessionId = sessionIdCacheRef.current[key];
        delete sessionIdCacheRef.current[key];
        if (cachedSessionId) delete etagsRef.current[cachedSessionId];
      }
    }
  }, [columns]);

  return entries;
}
