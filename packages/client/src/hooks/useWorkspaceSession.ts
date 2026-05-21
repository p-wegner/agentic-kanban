import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import type { AgentOutputMessage, SessionSummaryResponse } from "@agentic-kanban/shared";

interface SessionInfo {
  id: string;
  workspaceId: string;
  executor: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  exitCode: string | null;
  stats: string | null;
  providerSessionId: string | null;
}

interface UseWorkspaceSessionParams {
  selectedWorkspace: string | null;
  activeSession: string | null;
  issue: { id: string; title: string; description?: string | null };
  setActiveSession: (id: string | null) => void;
  setLastPrompt: (prompt: string) => void;
  setError: (msg: string | null) => void;
}

interface UseWorkspaceSessionResult {
  workspaceSessions: Record<string, SessionInfo[]>;
  setWorkspaceSessions: React.Dispatch<React.SetStateAction<Record<string, SessionInfo[]>>>;
  selectedHistoryId: string | null;
  setSelectedHistoryId: React.Dispatch<React.SetStateAction<string | null>>;
  historyMessages: AgentOutputMessage[];
  setHistoryMessages: React.Dispatch<React.SetStateAction<AgentOutputMessage[]>>;
  viewMode: "output" | "summary";
  setViewMode: React.Dispatch<React.SetStateAction<"output" | "summary">>;
  summaryData: SessionSummaryResponse | null;
  summaryLoading: boolean;
  summarySessionId: string | null;
  lastSessionPerWorkspace: Record<string, string>;
  setLastSessionPerWorkspace: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  completedMessages: AgentOutputMessage[];
  setCompletedMessages: React.Dispatch<React.SetStateAction<AgentOutputMessage[]>>;
  handleViewHistory: (sessionId: string) => Promise<void>;
  handleFetchSummary: (sessionId: string, force?: boolean) => Promise<void>;
}

export function useWorkspaceSession({
  selectedWorkspace,
  activeSession,
  issue,
  setActiveSession,
  setLastPrompt,
  setError,
}: UseWorkspaceSessionParams): UseWorkspaceSessionResult {
  const [workspaceSessions, setWorkspaceSessions] = useState<Record<string, SessionInfo[]>>({});
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [historyMessages, setHistoryMessages] = useState<AgentOutputMessage[]>([]);
  const [viewMode, setViewMode] = useState<"output" | "summary">("output");
  const [summaryData, setSummaryData] = useState<SessionSummaryResponse | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summarySessionId, setSummarySessionId] = useState<string | null>(null);
  const [lastSessionPerWorkspace, setLastSessionPerWorkspace] = useState<Record<string, string>>({});
  const [completedMessages, setCompletedMessages] = useState<AgentOutputMessage[]>([]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    if (workspaceSessions[selectedWorkspace]) return;

    apiFetch<SessionInfo[]>(`/api/workspaces/${selectedWorkspace}/sessions`)
      .then((sessions) => {
        setWorkspaceSessions((prev) => ({ ...prev, [selectedWorkspace!]: sessions }));
      })
      .catch(() => {});
  }, [selectedWorkspace]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    const sessions = workspaceSessions[selectedWorkspace];
    if (!sessions || sessions.length === 0) return;
    if (completedMessages.length > 0 || activeSession) return;

    const wsId = selectedWorkspace;
    const defaultPrompt = `${issue.title}${issue.description ? `\n\n${issue.description}` : ""}`;

    const running = sessions.find(s => s.status === "running");
    if (running) {
      apiFetch<AgentOutputMessage[]>(`/api/sessions/${running.id}/output`)
        .then((msgs) => {
          if (msgs.some(m => m.type === "exit")) {
            setLastSessionPerWorkspace((prev) => ({ ...prev, [wsId]: running.id }));
            setCompletedMessages(msgs);
            setSelectedHistoryId(running.id);
            setHistoryMessages(msgs);
          } else if (msgs.length === 0) {
            const ageMs = Date.now() - new Date(running.startedAt).getTime();
            if (ageMs > 2 * 60 * 1000) {
              setLastSessionPerWorkspace((prev) => ({ ...prev, [wsId]: running.id }));
              setCompletedMessages(msgs);
            } else {
              setActiveSession(running.id);
              setLastPrompt(defaultPrompt);
            }
          } else {
            setActiveSession(running.id);
            setLastPrompt(defaultPrompt);
          }
        })
        .catch(() => {
          setActiveSession(running.id);
          setLastPrompt(defaultPrompt);
        });
      return;
    }

    const sortedCompleted = sessions
      .filter(s => s.status !== "running")
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    (async () => {
      for (const session of sortedCompleted) {
        try {
          const msgs = await apiFetch<AgentOutputMessage[]>(`/api/sessions/${session.id}/output`);
          setLastSessionPerWorkspace((prev) => ({ ...prev, [wsId]: session.id }));
          if (msgs.length > 0) {
            setCompletedMessages(msgs);
            setSelectedHistoryId(session.id);
            setHistoryMessages(msgs);
            break;
          }
        } catch {
          break;
        }
      }
    })();
  }, [selectedWorkspace, workspaceSessions, activeSession]);

  async function handleViewHistory(sessionId: string) {
    try {
      const msgs = await apiFetch<AgentOutputMessage[]>(`/api/sessions/${sessionId}/output`);
      setHistoryMessages(msgs);
      setSelectedHistoryId(sessionId);
      setViewMode("output");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load session output");
    }
  }

  async function handleFetchSummary(sessionId: string, force = false) {
    if (!force && summarySessionId === sessionId && summaryData) return;
    setSummaryLoading(true);
    setSummaryData(null);
    try {
      const data = await apiFetch<SessionSummaryResponse>(`/api/sessions/${sessionId}/summary`);
      setSummaryData(data);
      setSummarySessionId(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load session summary");
    } finally {
      setSummaryLoading(false);
    }
  }

  return {
    workspaceSessions,
    setWorkspaceSessions,
    selectedHistoryId,
    setSelectedHistoryId,
    historyMessages,
    setHistoryMessages,
    viewMode,
    setViewMode,
    summaryData,
    summaryLoading,
    summarySessionId,
    lastSessionPerWorkspace,
    setLastSessionPerWorkspace,
    completedMessages,
    setCompletedMessages,
    handleViewHistory,
    handleFetchSummary,
  };
}
