import React from "react";
import { getWorkspacePreviewUrl } from "../lib/workspace-preview.js";
import { WorkspaceActionButton } from "./WorkspaceActionButton.js";
import type { WorkspaceResponse, DiffResponse, DiffComment } from "@agentic-kanban/shared";
import type { SessionInfo } from "./WorkspaceCard.js";

export interface WorkspaceActionBarProps {
  ws: WorkspaceResponse;
  sessions: SessionInfo[];
  selectedWorkspace: string | null;
  isRunning: boolean;
  actionLoading: boolean;
  diff: DiffResponse | null;
  diffComments: DiffComment[];
  canResume: (ws: WorkspaceResponse, sessions: SessionInfo[]) => boolean;
  canRestart: (ws: WorkspaceResponse, sessions: SessionInfo[]) => boolean;
  handleResume: (wsId: string, skipPermissions?: boolean) => void;
  handleRestart: (wsId: string, skipPermissions?: boolean) => void;
  handleViewDiff: (wsId: string) => void;
  handleReview: (wsId: string) => void;
  handleMerge: (wsId: string) => void;
  handleUpdateBase: (wsId: string, mode: "rebase" | "merge") => void;
  handleOpenTerminal: (wsId: string) => void;
  handleOpenEditor: (wsId: string) => void;
  copyPreviewUrl: (url: string) => void;
  handleAutoBisect: (wsId: string, scope?: "related" | "full") => void;
  handleCloseWorkspace: (wsId: string) => void;
  handleDeleteWorkspace: (wsId: string) => void;
}

export function WorkspaceActionBar({
  ws,
  sessions,
  selectedWorkspace,
  isRunning,
  actionLoading,
  diff,
  diffComments,
  canResume,
  canRestart,
  handleResume,
  handleRestart,
  handleViewDiff,
  handleReview,
  handleMerge,
  handleUpdateBase,
  handleOpenTerminal,
  handleOpenEditor,
  copyPreviewUrl,
  handleAutoBisect,
  handleCloseWorkspace,
  handleDeleteWorkspace,
}: WorkspaceActionBarProps) {
  const preview = getWorkspacePreviewUrl(ws);
  return (
            <div className="flex gap-2 flex-wrap items-center rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/70 dark:bg-gray-900/40 p-2">
              {ws.workingDir && canResume(ws, sessions) && (
                <div className="inline-flex">
                  <WorkspaceActionButton
                    intent="accent"
                    rounded="rounded-l-md"
                    onClick={() => handleResume(ws.id)}
                    disabled={actionLoading}
                  >
                    Resume
                  </WorkspaceActionButton>
                  <WorkspaceActionButton
                    intent="accent"
                    rounded="rounded-r-md"
                    className="px-2 border-l border-accent-700"
                    onClick={() => handleResume(ws.id, true)}
                    disabled={actionLoading}
                    title="Resume with --dangerously-skip-permissions (bypasses all permission prompts)"
                  >
                    ⚡
                  </WorkspaceActionButton>
                </div>
              )}
              {ws.workingDir && canRestart(ws, sessions) && (
                <div className="inline-flex">
                  <WorkspaceActionButton
                    intent="primary"
                    rounded="rounded-l-md"
                    onClick={() => handleRestart(ws.id)}
                    disabled={actionLoading}
                    title="Start a new session (previous session has no resume ID)"
                  >
                    Restart
                  </WorkspaceActionButton>
                  <WorkspaceActionButton
                    intent="primary"
                    rounded="rounded-r-md"
                    className="px-2 border-l border-brand-700"
                    onClick={() => handleRestart(ws.id, true)}
                    disabled={actionLoading}
                    title="Restart with --dangerously-skip-permissions (bypasses all permission prompts)"
                  >
                    ⚡
                  </WorkspaceActionButton>
                </div>
              )}
              {ws.workingDir && (
              <WorkspaceActionButton
                intent="primary"
                className="flex-1"
                onClick={() => handleViewDiff(ws.id)}
                disabled={actionLoading}
              >
                {ws.isDirect ? "View Changes" : "View Diff"}
              </WorkspaceActionButton>
              )}
              {ws.workingDir && selectedWorkspace === ws.id && diff && (() => {
                const unresolved = diffComments.filter((c) => c.resolvedAt == null).length;
                if (unresolved === 0) return null;
                return (
                  <span
                    data-testid="unresolved-comments-badge"
                    className="self-center text-xs font-medium px-2 py-1 rounded bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300"
                    title="Unresolved diff comments — resolve them before merging"
                  >
                    {unresolved} unresolved
                  </span>
                );
              })()}
              {ws.workingDir && (
              <WorkspaceActionButton
                intent="primary"
                onClick={() => handleReview(ws.id)}
                disabled={actionLoading || isRunning}
                title="Trigger AI code review"
              >
                Review
              </WorkspaceActionButton>
              )}
              {ws.workingDir && (
              <WorkspaceActionButton
                intent="accent"
                className="flex-1"
                onClick={() => handleMerge(ws.id)}
                disabled={actionLoading}
              >
                {ws.isDirect ? "Close" : "Merge"}
              </WorkspaceActionButton>
              )}

              <span className="w-px bg-gray-300 dark:bg-gray-600 self-stretch mx-1" aria-hidden="true" />

              {!ws.isDirect && ws.workingDir && ws.status !== "closed" && !isRunning && (
                <WorkspaceActionButton
                  intent="neutral"
                  onClick={() => handleUpdateBase(ws.id, "rebase")}
                  disabled={actionLoading}
                  title="Rebase onto latest base branch"
                >
                  Update Base
                </WorkspaceActionButton>
              )}
              {ws.workingDir && (
              <WorkspaceActionButton
                intent="neutral"
                onClick={() => handleOpenTerminal(ws.id)}
                disabled={actionLoading}
                title="Open terminal in workspace directory"
              >
                Terminal
              </WorkspaceActionButton>
              )}
              {ws.workingDir && (
              <WorkspaceActionButton
                intent="neutral"
                onClick={() => handleOpenEditor(ws.id)}
                disabled={actionLoading}
                title="Open workspace directory in VS Code"
              >
                VS Code
              </WorkspaceActionButton>
              )}
              {ws.workingDir && preview.ok && (
                <div className="inline-flex">
                  <WorkspaceActionButton
                    intent="info"
                    rounded="rounded-l-md"
                    onClick={(event) => {
                      event.stopPropagation();
                      window.open(preview.url, "_blank", "noopener,noreferrer");
                    }}
                    disabled={actionLoading}
                    title={`Open dev preview at ${preview.url}`}
                  >
                    Preview
                  </WorkspaceActionButton>
                  <WorkspaceActionButton
                    intent="info"
                    rounded="rounded-r-md"
                    className="px-2 border-l border-sky-700"
                    onClick={(event) => {
                      event.stopPropagation();
                      void copyPreviewUrl(preview.url);
                    }}
                    disabled={actionLoading}
                    title={`Copy ${preview.url}`}
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    <span className="sr-only">Copy preview URL</span>
                  </WorkspaceActionButton>
                </div>
              )}
              {ws.workingDir && !preview.ok && (
                <WorkspaceActionButton
                  intent="neutral"
                  disabled
                  title={preview.reason}
                >
                  Preview unavailable
                </WorkspaceActionButton>
              )}
              {ws.workingDir && !isRunning && (
              <WorkspaceActionButton
                intent="warn"
                onClick={() => handleAutoBisect(ws.id)}
                disabled={actionLoading}
                title="Find the commit that introduced the failing test"
              >
                Auto-bisect
              </WorkspaceActionButton>
              )}

              <span className="w-px bg-gray-300 dark:bg-gray-600 self-stretch mx-1" aria-hidden="true" />

              {!ws.isDirect && ws.status !== "closed" && !isRunning && (
                <WorkspaceActionButton
                  intent="ghost"
                  onClick={() => handleCloseWorkspace(ws.id)}
                  disabled={actionLoading}
                  title="Close without merging (e.g. already merged elsewhere or abandoned). Keeps session history."
                >
                  Close
                </WorkspaceActionButton>
              )}
              <WorkspaceActionButton
                intent="ghost"
                className="!text-red-600 dark:!text-red-400 hover:!bg-red-50 dark:hover:!bg-red-950 !border-red-300 dark:!border-red-800"
                onClick={() => handleDeleteWorkspace(ws.id)}
                disabled={actionLoading}
                title="Delete this workspace permanently"
              >
                Delete
              </WorkspaceActionButton>
            </div>
  );
}
