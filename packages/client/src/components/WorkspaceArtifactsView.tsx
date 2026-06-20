import React from "react";
import { WorkspaceArtifactsBrowser } from "./WorkspaceArtifactsBrowser.js";
import type { IssueArtifact } from "@agentic-kanban/shared";

export interface WorkspaceArtifactsViewProps {
  wsId: string;
  includeVisualProof: boolean | undefined;
  visualProofArtifacts: IssueArtifact[];
  visualProofLoading: boolean;
}

export function WorkspaceArtifactsView({
  wsId,
  includeVisualProof,
  visualProofArtifacts,
  visualProofLoading,
}: WorkspaceArtifactsViewProps) {
  return (
            <div className="space-y-3">
              {visualProofArtifacts.length > 0 && (
                <div className="border border-amber-200 dark:border-amber-800 rounded overflow-hidden">
                  <div className="px-3 py-1.5 bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800 text-[10px] font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide">
                    Visual Proof ({visualProofArtifacts.length})
                  </div>
                  <div className="divide-y divide-amber-100 dark:divide-amber-900">
                    {visualProofArtifacts.map((a) => (
                      <div key={a.id} className="p-3 space-y-2">
                        {a.caption && (
                          <p className="text-xs text-gray-600 dark:text-gray-400 font-medium">{a.caption}</p>
                        )}
                        {a.type === "image" && (
                          <img
                            src={a.content}
                            alt={a.caption ?? "visual proof"}
                            className="max-w-full rounded border border-gray-200 dark:border-gray-700 cursor-pointer hover:opacity-90"
                            onClick={() => window.open(a.content, "_blank")}
                          />
                        )}
                        {a.type === "link" && (
                          <a href={a.content} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 dark:text-blue-400 underline break-all">{a.content}</a>
                        )}
                        {a.type === "text" && (
                          <pre className="text-[11px] font-mono text-gray-800 dark:text-gray-200 bg-gray-50 dark:bg-gray-900 rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap break-all">{a.content}</pre>
                        )}
                        {a.type === "video" && (
                          <video
                            src={a.content}
                            controls
                            className="max-h-80 w-full rounded border border-gray-200 dark:border-gray-700"
                          >
                            Your browser does not support the video tag.
                          </video>
                        )}
                        <p className="text-[10px] text-gray-400 dark:text-gray-500">{new Date(a.createdAt).toLocaleString("en-US")}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {!visualProofLoading && visualProofArtifacts.length === 0 && includeVisualProof && (
                <div className="text-xs text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800 rounded p-3 bg-amber-50 dark:bg-amber-900/20">
                  Visual proof requested — agent has not attached proof yet.
                </div>
              )}
              <WorkspaceArtifactsBrowser workspaceId={wsId} />
            </div>
  );
}
