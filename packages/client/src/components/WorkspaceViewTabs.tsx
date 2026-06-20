import React from "react";
import type { AgentOutputMessage, IssueArtifact, WorkspaceResponse } from "@agentic-kanban/shared";
import type { WorkspaceViewMode } from "../hooks/useWorkspaceSession.js";

export interface WorkspaceViewTabsProps {
  ws: WorkspaceResponse;
  viewMode: WorkspaceViewMode;
  setViewMode: React.Dispatch<React.SetStateAction<WorkspaceViewMode>>;
  selectedHistoryId: string | null;
  historyMessages: AgentOutputMessage[];
  activeSession: string | null;
  completedMessages: AgentOutputMessage[];
  lastSessionPerWorkspace: Record<string, string>;
  isRunning: boolean;
  visualProofArtifacts: IssueArtifact[];
  handleFetchSummary: (sessionId: string, isRunning: boolean) => void;
}

export function WorkspaceViewTabs({
  ws,
  viewMode,
  setViewMode,
  selectedHistoryId,
  historyMessages,
  activeSession,
  completedMessages,
  lastSessionPerWorkspace,
  isRunning,
  visualProofArtifacts,
  handleFetchSummary,
}: WorkspaceViewTabsProps) {
  return (
            <div className="flex border-b border-gray-200 dark:border-gray-700">
              {((selectedHistoryId ? historyMessages : (activeSession || completedMessages.length > 0)) || ws.workingDir) && (
                <button
                  onClick={() => { setViewMode("output"); }}
                  className={`flex-1 text-xs py-1.5 text-center font-medium ${
                    viewMode === "output"
                      ? "text-blue-700 border-b-2 border-blue-600"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                  }`}
                >
                  Output
                </button>
              )}
              {(selectedHistoryId ? historyMessages : (activeSession || completedMessages.length > 0)) && (
                <button
                  onClick={() => {
                    setViewMode("summary");
                    const sid = selectedHistoryId || activeSession || lastSessionPerWorkspace[ws.id];
                    if (sid) handleFetchSummary(sid, isRunning);
                  }}
                  className={`flex-1 text-xs py-1.5 text-center font-medium ${
                    viewMode === "summary"
                      ? "text-blue-700 border-b-2 border-blue-600"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                  }`}
                >
                  Summary
                </button>
              )}
              {ws.workingDir && (
                <button
                  onClick={() => { setViewMode("preview"); }}
                  className={`flex-1 text-xs py-1.5 text-center font-medium ${
                    viewMode === "preview"
                      ? "text-blue-700 border-b-2 border-blue-600"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                  }`}
                >
                  Preview
                </button>
              )}
              {ws.workingDir && (
                <button
                  onClick={() => { setViewMode("artifacts"); }}
                  className={`flex-1 text-xs py-1.5 text-center font-medium ${
                    viewMode === "artifacts"
                      ? "text-blue-700 border-b-2 border-blue-600"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                  }`}
                >
                  Artifacts{visualProofArtifacts.length > 0 ? ` (${visualProofArtifacts.length})` : ws.includeVisualProof ? " ·" : ""}
                </button>
              )}
              <button
                onClick={() => { setViewMode("diagnostics"); }}
                className={`flex-1 text-xs py-1.5 text-center font-medium ${
                  viewMode === "diagnostics"
                    ? "text-blue-700 border-b-2 border-blue-600"
                    : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                }`}
              >
                Diagnostics
              </button>
              <button
                onClick={() => { setViewMode("timeline"); }}
                className={`flex-1 text-xs py-1.5 text-center font-medium ${
                  viewMode === "timeline"
                    ? "text-blue-700 border-b-2 border-blue-600"
                    : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                }`}
              >
                Timeline
              </button>
              {ws.contextPrimer && (
                <button
                  onClick={() => { setViewMode("context"); }}
                  className={`flex-1 text-xs py-1.5 text-center font-medium ${
                    viewMode === "context"
                      ? "text-blue-700 border-b-2 border-blue-600"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                  }`}
                >
                  Context
                </button>
              )}
            </div>
  );
}
