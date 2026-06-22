import { useEffect, useRef } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { STATUS_COLORS } from "../lib/chartColors";
import type { CriticalPathResult, ChainStep } from "../lib/criticalPath.js";

interface CriticalPathSidePanelProps {
  chainRoot: string;
  criticalPathResult: CriticalPathResult;
  nodeIssueMap: Map<string, IssueWithStatus>;
  onClose: () => void;
  onIssueClick: (issue: IssueWithStatus) => void;
}

export function CriticalPathSidePanel({ chainRoot, criticalPathResult, nodeIssueMap, onClose, onIssueClick }: CriticalPathSidePanelProps) {
  const chain = criticalPathResult.chainsByRoot.get(chainRoot);
  const rootBlocker = criticalPathResult.rootBlockers.find((r) => r.id === chainRoot);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  if (!chain || chain.length === 0) return null;

  return (
    <div className="absolute top-0 right-0 bottom-0 z-20 animate-slide-in-right" style={{ width: 320 }}>
      <div ref={panelRef} className="h-full bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 shadow-lg flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
              Critical Path
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {rootBlocker ? `${rootBlocker.downstreamCount} issue${rootBlocker.downstreamCount !== 1 ? "s" : ""} blocked downstream` : "Chain details"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded px-1.5 py-0.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800 text-sm"
          >
            ✕
          </button>
        </div>

        {/* Chain steps */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {chain.map((step: ChainStep, idx: number) => {
            const isRoot = idx === 0;
            return (
              <div key={step.id}>
                <button
                  onClick={() => {
                    const issue = nodeIssueMap.get(step.id);
                    if (issue) onIssueClick(issue);
                  }}
                  className={`w-full text-left rounded-md px-2.5 py-2 mb-0.5 transition-colors ${
                    isRoot
                      ? "bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800"
                      : "hover:bg-gray-50 dark:hover:bg-gray-800 border border-transparent"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {step.issueNumber != null && (
                      <span className="text-[10px] font-mono text-gray-400">#{step.issueNumber}</span>
                    )}
                    <span className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">
                      {step.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span
                      className="w-1.5 h-1.5 rounded-full inline-block"
                      style={{ background: STATUS_COLORS[step.statusName] ?? "#6b7280" }}
                    />
                    <span className="text-[10px] text-gray-500 dark:text-gray-400">{step.statusName}</span>
                    {isRoot && (
                      <span className="text-[10px] px-1 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 ml-auto">
                        root blocker
                      </span>
                    )}
                    {step.isBlocked && !isRoot && (
                      <span className="text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 ml-auto">
                        blocked
                      </span>
                    )}
                  </div>
                </button>
                {/* Connector arrow */}
                {idx < chain.length - 1 && (
                  <div className="flex items-center justify-center py-0.5">
                    <svg width="12" height="12" viewBox="0 0 12 12" className="text-gray-300 dark:text-gray-600">
                      <path d="M6 2 L6 8 M3 6 L6 9 L9 6" stroke="currentColor" strokeWidth="1.5" fill="none" />
                    </svg>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Best unblock callout */}
        {criticalPathResult.bestUnblock && (
          <div className="border-t border-gray-200 dark:border-gray-700 px-3 py-2.5 bg-amber-50 dark:bg-amber-900/20">
            <div className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 uppercase tracking-wide mb-1">
              Next best unblock
            </div>
            <button
              onClick={() => {
                const issue = nodeIssueMap.get(criticalPathResult.bestUnblock!.id);
                if (issue) onIssueClick(issue);
              }}
              className="w-full text-left"
            >
              <span className="text-xs text-gray-800 dark:text-gray-200">
                Resolve{" "}
                {(() => {
                  const bi = nodeIssueMap.get(criticalPathResult.bestUnblock.id);
                  return bi ? (
                    <>
                      {bi.issueNumber != null && <span className="font-mono text-gray-500">#{bi.issueNumber}</span>}
                      {" "}{bi.title.length > 32 ? bi.title.slice(0, 32) + "…" : bi.title}
                    </>
                  ) : "this issue";
                })()}
              </span>
              <span className="block text-[10px] text-amber-600 dark:text-amber-400 mt-0.5">
                to unblock {criticalPathResult.bestUnblock.downstreamCount} issue{criticalPathResult.bestUnblock.downstreamCount !== 1 ? "s" : ""}
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
