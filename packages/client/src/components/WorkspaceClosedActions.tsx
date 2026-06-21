import React from "react";
import ReactMarkdown from "react-markdown";
import { WorkspaceActionButton } from "./WorkspaceActionButton.js";

export interface WorkspaceClosedActionsProps {
  wsId: string;
  actionLoading: boolean;
  githubDrafts: Record<string, string | null>;
  handleGenerateGithubDraft: (wsId: string) => void;
  handleExportHandoffBundle: (wsId: string) => Promise<void>;
  handleDeleteWorkspace: (wsId: string) => void;
  handleCopyGithubDraft: (content: string) => void;
}

export function WorkspaceClosedActions({
  wsId,
  actionLoading,
  githubDrafts,
  handleGenerateGithubDraft,
  handleExportHandoffBundle,
  handleDeleteWorkspace,
  handleCopyGithubDraft,
}: WorkspaceClosedActionsProps) {
  return (
            <div className="pt-2 border-t border-gray-200 dark:border-gray-700 space-y-2">
              <div className="flex gap-2 flex-wrap items-center rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/70 dark:bg-gray-900/40 p-2">
                <WorkspaceActionButton
                  intent="info"
                  className="flex-1"
                  onClick={() => handleGenerateGithubDraft(wsId)}
                  disabled={actionLoading}
                  title="Generate a local GitHub PR or release-note draft and save it as an issue artifact"
                >
                  Generate GitHub Draft
                </WorkspaceActionButton>
                <WorkspaceActionButton
                  intent="warn"
                  onClick={() => void handleExportHandoffBundle(wsId)}
                  disabled={actionLoading}
                  title="Download a Markdown handoff bundle for this workspace"
                >
                  Export Handoff
                </WorkspaceActionButton>
                <WorkspaceActionButton
                  intent="danger"
                  onClick={() => handleDeleteWorkspace(wsId)}
                  disabled={actionLoading}
                  title="Delete this workspace permanently"
                >
                  Delete
                </WorkspaceActionButton>
              </div>
              {githubDrafts[wsId] && (
                <details className="text-xs">
                  <summary className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide cursor-pointer hover:text-gray-600 dark:hover:text-gray-300 flex items-center gap-2">
                    <span>GitHub Draft</span>
                    <button
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void handleCopyGithubDraft(githubDrafts[wsId]!);
                      }}
                      className="ml-auto text-[10px] text-blue-600 hover:text-blue-700"
                    >
                      Copy
                    </button>
                  </summary>
                  <div className="mt-1 bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded p-2 max-h-56 overflow-y-auto">
                    <div className="prose prose-xs max-w-none text-[11px] leading-relaxed text-gray-700 dark:text-gray-300">
                      <ReactMarkdown>{githubDrafts[wsId]}</ReactMarkdown>
                    </div>
                  </div>
                </details>
              )}
            </div>
  );
}
