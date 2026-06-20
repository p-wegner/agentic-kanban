import React from "react";
import type { AgentOutputMessage, WorkspaceResponse } from "@agentic-kanban/shared";
import type { WorkspaceViewMode } from "../hooks/useWorkspaceSession.js";
import type { SessionInfo } from "./WorkspaceCard.js";

export interface WorkspaceFixingStatusProps {
  ws: WorkspaceResponse;
  sessions: SessionInfo[];
  activeSession: string | null;
  messages: AgentOutputMessage[];
  wsState: "connecting" | "open" | "closed" | "error";
  actionLoading: boolean;
  setSelectedHistoryId: (id: string | null) => void;
  setActiveSession: React.Dispatch<React.SetStateAction<string | null>>;
  setViewMode: React.Dispatch<React.SetStateAction<WorkspaceViewMode>>;
  handleViewHistory: (sessionId: string) => void;
  handleStop: (wsId: string) => void;
}

export function WorkspaceFixingStatus({
  ws,
  sessions,
  activeSession,
  messages,
  wsState,
  actionLoading,
  setSelectedHistoryId,
  setActiveSession,
  setViewMode,
  handleViewHistory,
  handleStop,
}: WorkspaceFixingStatusProps) {
        const fixSession = sessions.find(s => s.triggerType === "fix-and-merge" && s.status === "running")
          ?? sessions.filter(s => s.triggerType === "fix-and-merge").at(-1);
        const conflictFiles = ws.conflicts?.conflictingFiles ?? [];
        const watchingLive = !!fixSession && activeSession === fixSession.id;
        const noOutputYet = watchingLive && messages.length === 0;
  return (
          <div className="mt-2 p-2 bg-orange-50 dark:bg-orange-950 border border-orange-200 dark:border-orange-800 rounded space-y-1.5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-orange-700 dark:text-orange-400 animate-pulse">AI Fixing Conflicts</span>
              {ws.baseBranch && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">
                  target: {ws.baseBranch}
                </span>
              )}
              {watchingLive && (
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${wsState === "open" ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-600"}`}>
                  {wsState === "open" ? "● live" : wsState}
                </span>
              )}
            </div>
            {conflictFiles.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold text-orange-600 dark:text-orange-400 uppercase tracking-wide mb-0.5">
                  {conflictFiles.length} conflicting file{conflictFiles.length !== 1 ? "s" : ""}
                </div>
                <ul className="text-xs text-orange-700 dark:text-orange-300 space-y-0.5">
                  {conflictFiles.map(f => (
                    <li key={f} className="font-mono truncate">{f}</li>
                  ))}
                </ul>
              </div>
            )}
            {noOutputYet && (
              <div className="text-xs text-orange-600 dark:text-orange-400">
                Connected — waiting for the agent's first output. If nothing appears after a minute or two the session may be stuck; use Stop and retry.
              </div>
            )}
            <div className="flex items-center gap-3">
              {fixSession && !watchingLive && (
                <button
                  onClick={() => { setSelectedHistoryId(null); setActiveSession(fixSession.id); setViewMode("output"); }}
                  className="text-xs text-orange-700 dark:text-orange-300 hover:text-orange-900 dark:hover:text-orange-100 underline font-medium"
                >
                  Watch live output
                </button>
              )}
              {fixSession && (
                <button
                  onClick={() => handleViewHistory(fixSession.id)}
                  className="text-xs text-orange-600 dark:text-orange-400 hover:text-orange-800 dark:hover:text-orange-200 underline"
                >
                  View session log
                </button>
              )}
              <button
                onClick={() => handleStop(ws.id)}
                disabled={actionLoading}
                className="text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-200 underline disabled:opacity-50 ml-auto"
              >
                Stop fix session
              </button>
            </div>
          </div>
  );
}
