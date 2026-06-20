import React from "react";
import ReactMarkdown from "react-markdown";
import { formatTokenCount, parseStats } from "../lib/workspace-helpers.js";
import type { SessionSummaryResponse } from "@agentic-kanban/shared";

export interface WorkspaceSummaryViewProps {
  selectedHistoryId: string | null;
  activeSession: string | null;
  lastSessionPerWorkspace: Record<string, string>;
  wsId: string;
  summarySessionId: string | null;
  summaryData: SessionSummaryResponse | null;
  summaryLoading: boolean;
}

export function WorkspaceSummaryView({
  selectedHistoryId,
  activeSession,
  lastSessionPerWorkspace,
  wsId,
  summarySessionId,
  summaryData,
  summaryLoading,
}: WorkspaceSummaryViewProps) {
  const sid = selectedHistoryId || activeSession || lastSessionPerWorkspace[wsId];
  const summary = sid === summarySessionId ? summaryData : null;
  return (
              <div className="border border-gray-200 dark:border-gray-700 rounded p-3 space-y-3 text-sm max-h-80 overflow-y-auto">
                {summaryLoading && (
                  <div className="text-gray-500 dark:text-gray-400 text-xs animate-pulse">Loading summary...</div>
                )}
                {!summaryLoading && !summary && (
                  <div className="text-gray-400 dark:text-gray-500 text-xs">No summary available. Click Summary again to load.</div>
                )}
                {summary && (
                  <>
                    {summary.agentSummary && (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-1">Summary</h4>
                        <div className="markdown-body text-xs bg-blue-50 dark:bg-blue-950 border border-blue-100 dark:border-blue-900 rounded p-2.5 leading-relaxed">
                          <ReactMarkdown>{summary.agentSummary}</ReactMarkdown>
                        </div>
                      </div>
                    )}

                    <div>
                      <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-1">Overview</h4>
                      <p className="text-gray-600 dark:text-gray-400 text-xs">{summary.overview}</p>
                      {summary.model && (
                        <p className="text-gray-400 dark:text-gray-500 text-[10px] mt-0.5">Model: {summary.model}</p>
                      )}
                    </div>

                    {summary.stats && (() => {
                      const s = parseStats(JSON.stringify(summary.stats));
                      if (!s) return null;
                      return (
                        <div className="flex items-center gap-3 text-[10px] text-gray-400 dark:text-gray-500">
                          {s.inputTokens > 0 && <span>{formatTokenCount(s.inputTokens)} in / {formatTokenCount(s.outputTokens)} out</span>}
                          {s.totalCostUsd > 0 && <span>${s.totalCostUsd.toFixed(2)}</span>}
                          {s.durationMs > 0 && <span>{(s.durationMs / 1000).toFixed(0)}s</span>}
                          {s.numTurns > 1 && <span>{s.numTurns} turns</span>}
                          {summary.duration && <span>({summary.duration})</span>}
                        </div>
                      );
                    })()}

                    {summary.tasks && summary.tasks.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-1">
                          Tasks ({summary.tasks.filter(t => t.status === "completed").length}/{summary.tasks.length})
                        </h4>
                        <ul className="space-y-1">
                          {summary.tasks.filter(t => t.status !== "deleted").map((task) => (
                            <li key={task.id} className="flex items-start gap-1.5 text-xs">
                              <span className="mt-0.5 shrink-0">
                                {task.status === "completed" ? "Ô£ô" : task.status === "in_progress" ? "Ôƒ│" : "Ôùï"}
                              </span>
                              <span className={task.status === "completed" ? "text-gray-400 dark:text-gray-500 line-through" : "text-gray-700 dark:text-gray-300"}>
                                {task.subject}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {summary.filesRead.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-1">Files Read ({summary.filesRead.length})</h4>
                        <ul className="text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
                          {summary.filesRead.slice(0, 20).map((f) => (
                            <li key={f} className="font-mono text-[11px] truncate">{f}</li>
                          ))}
                          {summary.filesRead.length > 20 && (
                            <li className="text-gray-400 dark:text-gray-500">...and {summary.filesRead.length - 20} more</li>
                          )}
                        </ul>
                      </div>
                    )}

                    {summary.filesEdited.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-1">Files Edited ({summary.filesEdited.length})</h4>
                        <ul className="text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
                          {summary.filesEdited.map((f) => (
                            <li key={f} className="font-mono text-[11px] truncate">{f}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {summary.filesWritten.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-1">Files Written ({summary.filesWritten.length})</h4>
                        <ul className="text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
                          {summary.filesWritten.map((f) => (
                            <li key={f} className="font-mono text-[11px] truncate">{f}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {summary.commandsRun.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-1">Commands ({summary.commandsRun.length})</h4>
                        <ul className="text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
                          {summary.commandsRun.slice(0, 15).map((cmd, i) => (
                            <li key={i} className="font-mono text-[11px] truncate">{cmd}</li>
                          ))}
                          {summary.commandsRun.length > 15 && (
                            <li className="text-gray-400 dark:text-gray-500">...and {summary.commandsRun.length - 15} more</li>
                          )}
                        </ul>
                      </div>
                    )}

                    {summary.keyExcerpts.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-1">Agent Excerpts</h4>
                        <div className="space-y-1.5">
                          {summary.keyExcerpts.slice(0, 5).map((excerpt, i) => (
                            <div key={i} className="text-xs text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 rounded p-2 whitespace-pre-wrap">
                              {excerpt}
                            </div>
                          ))}
                          {summary.keyExcerpts.length > 5 && (
                            <p className="text-gray-400 dark:text-gray-500 text-[10px]">...and {summary.keyExcerpts.length - 5} more excerpts</p>
                          )}
                        </div>
                      </div>
                    )}

                    {summary.errors.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-1">Errors ({summary.errors.length})</h4>
                        <ul className="text-xs text-red-600 space-y-0.5">
                          {summary.errors.slice(0, 5).map((err, i) => (
                            <li key={i} className="font-mono text-[11px] break-all">{err}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
              </div>
  );
}
