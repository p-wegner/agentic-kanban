import React from "react";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { getOutputFormatForAgent, getOutputFormatForProvider } from "../lib/agent-output-parser.js";
import { SessionStatsBadge } from "../lib/session-stats.js";
import {
  formatDuration,
  getTriggerTypeLabel,
  parseStats,
} from "../lib/workspace-helpers.js";
import type { WorkspaceResponse } from "@agentic-kanban/shared";
import type { SessionInfo } from "./WorkspaceCard.js";

export interface WorkspaceSessionListProps {
  ws: WorkspaceResponse;
  completedSessions: SessionInfo[];
  selectedHistoryId: string | null;
  actionLoading: boolean;
  prefs: Record<string, string>;
  handleViewHistory: (sessionId: string) => void;
  setReplaySession: React.Dispatch<React.SetStateAction<{ id: string; label: string; outputFormat: string } | null>>;
  handleContinueFromSession: (wsId: string, sessionId: string, skipPermissions?: boolean) => void;
  handleRestart: (wsId: string, skipPermissions?: boolean) => void;
}

export function WorkspaceSessionList({
  ws,
  completedSessions,
  selectedHistoryId,
  actionLoading,
  prefs,
  handleViewHistory,
  setReplaySession,
  handleContinueFromSession,
  handleRestart,
}: WorkspaceSessionListProps) {
  return (
            <div className="space-y-1">
              <div className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">Sessions</div>
              {(() => {
                const specialSessions = completedSessions.filter(s =>
                  s.triggerType && s.triggerType !== "agent" && s.triggerType !== "chat"
                  || (!s.triggerType && s.skillName)
                );
                if (specialSessions.length === 0) return null;
                const counts = new Map<string, { label: string; className: string; count: number; lastStatus: string }>();
                for (const s of specialSessions) {
                  const tl = getTriggerTypeLabel(s.triggerType, s.skillName) ?? { label: s.triggerType ?? "Skill", className: "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300" };
                  const key = s.triggerType ?? `skill:${s.skillName}`;
                  const existing = counts.get(key);
                  if (existing) { existing.count++; existing.lastStatus = s.status; }
                  else counts.set(key, { ...tl, count: 1, lastStatus: s.status });
                }
                return (
                  <div className="flex flex-wrap gap-1 pb-0.5">
                    {[...counts.entries()].map(([key, { label, className, count, lastStatus }]) => (
                      <span key={key} className={`text-[10px] font-medium px-1.5 py-0.5 rounded flex items-center gap-1 ${className}`}>
                        {label}
                        <span className="opacity-60">×{count}</span>
                        {lastStatus === "completed" ? <span className="text-green-600">✓</span> : lastStatus === "stopped" ? <span className="text-yellow-500">⏹</span> : null}
                      </span>
                    ))}
                  </div>
                );
              })()}
              <div className="space-y-0.5 max-h-48 overflow-y-auto">
              {completedSessions.map((session) => {
                const isActive = selectedHistoryId === session.id;
                const isContinuation = !!session.resumeFromId && completedSessions.some(s => s.id === session.resumeFromId);
                return (
                  <div key={session.id} className={`flex items-center gap-1 ${isContinuation ? "ml-3" : ""}`}>
                    {isContinuation && (
                      <span className="text-gray-300 dark:text-gray-600 shrink-0 select-none">↳</span>
                    )}
                    <button
                      data-session-id={session.id}
                      onClick={() => handleViewHistory(session.id)}
                      className={`flex-1 flex items-center gap-2 py-1 px-2 rounded text-left text-xs ${
                        isActive
                          ? "bg-blue-50 dark:bg-blue-950 text-blue-700 font-medium"
                          : "hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300"
                      }`}
                    >
                      {(() => {
                        const tl = getTriggerTypeLabel(session.triggerType, session.skillName);
                        const parsedStats = parseStats(session.stats);
                        const isAgentOrChat = (session.triggerType === "agent" || session.triggerType === "chat" || !session.triggerType) && !session.skillName;
                        const statusDot = <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${session.status === "completed" ? "bg-green-500" : session.status === "stopped" ? "bg-yellow-500" : "bg-blue-400"}`} />;
                        const fallbackLabel = { label: "Agent", className: "bg-blue-50 text-blue-600" };
                        if (isAgentOrChat) {
                          return (
                            <>
                              {statusDot}
                              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${(tl ?? fallbackLabel).className}`}>{(tl ?? fallbackLabel).label}</span>
                            </>
                          );
                        }
                        const succeeded = parsedStats?.success;
                        const outcomeIcon = session.status === "completed"
                          ? (succeeded === false ? <span className="text-red-500 font-bold text-[10px]">✗</span> : <span className="text-green-500 font-bold text-[10px]">✓</span>)
                          : session.status === "stopped" ? <span className="text-yellow-500 font-bold text-[10px]">⏹</span>
                          : statusDot;
                        return (
                          <>
                            {outcomeIcon}
                            {tl && <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded ${tl.className}`}>{tl.label}</span>}
                          </>
                        );
                      })()}
                      <span className="text-xs text-gray-600 dark:text-gray-400">
                        {formatRelativeTime(session.startedAt)}
                      </span>
                      <span className="text-[10px] text-gray-400 dark:text-gray-500 ml-auto">
                        ({formatDuration(session.startedAt, session.endedAt)})
                      </span>
                      <SessionStatsBadge stats={session.stats} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const outputFormat = ws.provider
                          ? getOutputFormatForProvider(ws.provider)
                          : getOutputFormatForAgent(ws.agentCommand ?? prefs.agent_command);
                        const label = getTriggerTypeLabel(session.triggerType, session.skillName)?.label ?? "Agent";
                        setReplaySession({ id: session.id, label: `${label} · ${formatRelativeTime(session.startedAt)}`, outputFormat });
                      }}
                      className="text-[10px] text-gray-400 dark:text-gray-500 hover:text-blue-500 dark:hover:text-blue-400 px-1.5 py-0.5 rounded hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors shrink-0"
                      title="Step through this session turn by turn"
                    >
                      ⏯ Replay
                    </button>
                    {ws.status !== "closed" && (
                      session.providerSessionId ? (
                        <div className="flex shrink-0">
                          <button
                            onClick={() => handleContinueFromSession(ws.id, session.id)}
                            disabled={actionLoading}
                            className="text-[10px] bg-green-600 text-white px-1.5 py-0.5 rounded-l hover:bg-green-700 disabled:opacity-50"
                            title="Continue this session with --resume"
                          >
                            Continue
                          </button>
                          <button
                            onClick={() => handleContinueFromSession(ws.id, session.id, true)}
                            disabled={actionLoading}
                            className="text-[10px] bg-green-700 text-white px-1 py-0.5 rounded-r hover:bg-green-800 disabled:opacity-50 border-l border-green-500"
                            title="Continue with --dangerously-skip-permissions (bypasses all permission prompts)"
                          >
                            ⚡
                          </button>
                        </div>
                      ) : (
                        <div className="flex shrink-0">
                          <button
                            onClick={() => handleRestart(ws.id)}
                            disabled={actionLoading}
                            className="text-[10px] bg-brand-600 text-white px-1.5 py-0.5 rounded-l hover:bg-brand-700 disabled:opacity-50"
                            title="Start a new session (previous session has no resume ID)"
                          >
                            Restart
                          </button>
                          <button
                            onClick={() => handleRestart(ws.id, true)}
                            disabled={actionLoading}
                            className="text-[10px] bg-brand-700 text-white px-1 py-0.5 rounded-r hover:bg-brand-800 disabled:opacity-50 border-l border-brand-500"
                            title="Restart with --dangerously-skip-permissions (bypasses all permission prompts)"
                          >
                            ⚡
                          </button>
                        </div>
                      )
                    )}
                  </div>
                );
              })}
              </div>
            </div>
  );
}
