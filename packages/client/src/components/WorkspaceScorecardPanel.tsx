import React from "react";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import type { ScorecardResult } from "./WorkspaceCard.js";

export interface WorkspaceScorecardPanelProps {
  wsId: string;
  scorecard: ScorecardResult;
  expandedScorecards: Record<string, boolean>;
  setExpandedScorecards: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}

export function WorkspaceScorecardPanel({
  wsId,
  scorecard,
  expandedScorecards,
  setExpandedScorecards,
}: WorkspaceScorecardPanelProps) {
  return (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 p-3 space-y-2">
          <button
            onClick={() => setExpandedScorecards((prev) => ({ ...prev, [wsId]: !prev[wsId] }))}
            className="flex items-center justify-between gap-3 w-full text-left"
          >
            <div className="flex items-center gap-1.5">
              <svg className={`w-3 h-3 text-gray-400 dark:text-gray-500 shrink-0 transition-transform ${expandedScorecards[wsId] ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              <div>
                <div className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">Scorecard</div>
                <div className="text-xs text-gray-400 dark:text-gray-500">Updated {formatRelativeTime(scorecard.computedAt)}</div>
              </div>
            </div>
            <span className={`inline-flex items-center px-2 py-1 rounded text-sm font-bold ${
              scorecard.total >= 80 ? "bg-green-100 text-green-700" :
              scorecard.total >= 60 ? "bg-yellow-100 text-yellow-700" :
              "bg-red-100 text-red-700"
            }`}>
              {scorecard.total}/100
            </span>
          </button>
          {expandedScorecards[wsId] && (
            <div className="space-y-2">
              {scorecard.dimensions.map((dimension) => {
                const percent = Math.max(0, Math.min(100, (dimension.score / dimension.maxScore) * 100));
                const barColor = percent >= 80 ? "bg-green-500" : percent >= 60 ? "bg-yellow-500" : "bg-red-500";
                return (
                  <div key={dimension.name} className="space-y-1">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-medium text-gray-700 dark:text-gray-200">{dimension.name}</span>
                      <span className="font-mono text-gray-500 dark:text-gray-400">{dimension.score}/{dimension.maxScore}</span>
                    </div>
                    <div className="h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                      <div className={`h-full rounded-full ${barColor}`} style={{ width: `${percent}%` }} />
                    </div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400">{dimension.signal}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
  );
}
