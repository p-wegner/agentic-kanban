import { useEffect, useState } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import type { LiveSessionStats } from "../lib/useBoardEvents.js";
import { formatRelativeTime, formatAbsoluteTime } from "../lib/formatRelativeTime.js";
import { getLastSessionBadge } from "../lib/sessionBadgeHelpers.js";
import { CodeMetricsBadges, WorkflowMiniIndicator } from "./IssueBadges.js";
import { groupConflictsByRepo, formatConflictSummary } from "../lib/groupConflictsByRepo.js";

function RelativeTime({ timestamp, prefix = "" }: { timestamp: string; prefix?: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return <span title={formatAbsoluteTime(timestamp)}>{prefix}{formatRelativeTime(timestamp)}</span>;
}

export function WorkspaceSummarySection(props: {
  issue: IssueWithStatus;
  ws: IssueWithStatus["workspaceSummary"];
  compact: boolean;
  liveActivity?: string;
  liveStats?: LiveSessionStats;
  onWorkspaceClick?: (issue: IssueWithStatus, workspaceId?: string) => void;
}) {
  // `ws` must be a const binding (not a parameter binding) so TypeScript keeps
  // its narrowing inside the click handler and idle-badge closures below —
  // matching the original `const ws = issue.workspaceSummary` in IssueCardBody.
  const { issue, ws, compact, liveActivity, liveStats, onWorkspaceClick } = props;
  return (
    <>
      {!compact && ws && ws.main && (
        <div
          className={`group/ws flex min-w-0 flex-wrap items-center gap-1.5 mt-1.5 text-xs cursor-pointer rounded px-1 py-1 -mx-1 border-t transition-colors overflow-hidden ${
            ws.main.status === "reviewing" ? "border-accent-200 bg-accent-50 hover:bg-accent-100 dark:border-accent-700 dark:bg-accent-900/40" :
            ws.main.status === "fixing" ? "border-orange-100 bg-orange-50 hover:bg-orange-100" :
            ws.main.status === "awaiting-plan-approval" ? "border-amber-200 bg-amber-50 hover:bg-amber-100" :
            ws.main.conflicts?.hasConflicts ? "border-red-100 bg-red-50 hover:bg-red-100" :
            "border-brand-100 bg-brand-50 hover:bg-brand-100 hover:border-brand-200"
          }`}
          title="Open workspace"
          onClick={(e) => { e.stopPropagation(); onWorkspaceClick?.(issue, ws.main?.id); }}
        >
          {ws.main.status === "reviewing" ? (
            <>
              <span className="inline-block w-2 h-2 rounded-full shrink-0 bg-accent-500 animate-pulse" />
              <span className="min-w-0 truncate font-medium text-accent-700 dark:text-accent-300">AI Reviewing</span>
              {ws.main.workflow && <WorkflowMiniIndicator workflow={ws.main.workflow} />}
            </>
          ) : ws.main.status === "fixing" ? (
            <>
              <span className="inline-block w-2 h-2 rounded-full shrink-0 bg-orange-500 animate-pulse" />
              <span className="min-w-0 truncate font-medium text-orange-700">AI Fixing Conflicts</span>
              {ws.main.workflow && <WorkflowMiniIndicator workflow={ws.main.workflow} />}
            </>
          ) : ws.main.status === "awaiting-plan-approval" ? (
            <>
              <span className="inline-block w-2 h-2 rounded-full shrink-0 bg-amber-500" />
              <span className="min-w-0 truncate font-medium text-amber-700">Plan Awaiting Approval</span>
              {ws.main.workflow && <WorkflowMiniIndicator workflow={ws.main.workflow} />}
            </>
          ) : ws.main.conflicts?.hasConflicts ? (
            <>
              <span className="inline-block w-2 h-2 rounded-full shrink-0 bg-red-500" />
              <span className="min-w-0 truncate font-medium text-red-700">Merge Conflicts</span>
              {ws.main.workflow && <WorkflowMiniIndicator workflow={ws.main.workflow} />}
            </>
          ) : (
            <>
              <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${
                ws.main.status === "active" ? "bg-green-500" :
                ws.main.status === "idle" ? "bg-amber-500" :
                "bg-gray-400"
              }`} />
              <span className="min-w-0 flex-1 basis-24 font-mono text-gray-600 dark:text-gray-400 truncate">{ws.main.branch}</span>
              {ws.main.workflow && <WorkflowMiniIndicator workflow={ws.main.workflow} />}
              {ws.main.status === "idle" && liveActivity && (() => {
                const badge = getLastSessionBadge(ws.main.lastSessionTriggerType);
                return badge ? <span className={`order-last text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${badge.className}`}>{badge.label}</span> : null;
              })()}
            </>
          )}
          {ws.main.status === "closed" && (
            ws.main.lastSessionTriggerType === "fix-conflicts" ? (
              <span className="order-last inline-flex items-center gap-1 font-medium shrink-0 text-orange-700"><span className="inline-block w-2 h-2 rounded-full shrink-0 bg-orange-400" />merged conflicts</span>
            ) : ws.main.mergedAt ? (
              <span className="order-last text-green-600 font-medium shrink-0">merged</span>
            ) : (
              <span className="order-last text-gray-500 font-medium shrink-0">closed</span>
            )
          )}
          {ws.main.latestCommit && ws.main.status !== "closed" && (
            <span className="order-last basis-full min-w-0 flex items-center gap-1 pt-0.5 text-[10px] text-gray-500 dark:text-gray-400">
              <span className="font-mono shrink-0 text-gray-400 dark:text-gray-500">{ws.main.latestCommit.sha}</span>
              <span className="truncate">{ws.main.latestCommit.message}</span>
            </span>
          )}
          <span className="order-last inline-flex basis-full min-w-0 flex-wrap items-center gap-1 pt-0.5 text-[10px] font-mono">
            {ws.main.scorecard && (
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${
                  ws.main.scorecard.score >= 80 ? "bg-green-100 text-green-700" :
                  ws.main.scorecard.score >= 60 ? "bg-yellow-100 text-yellow-700" :
                  "bg-red-100 text-red-700"
                }`}
                title={`PR Quality Score: ${ws.main.scorecard.score}/100`}
              >
            {ws.main.scorecard.score}
          </span>
        )}
            <CodeMetricsBadges commitCount={ws.main.commitCount} metrics={ws.main.codeMetrics} />
            {ws.main.diffStats && liveActivity && (
              <>
                <span className="text-green-600">+{ws.main.diffStats.insertions}</span>
                <span className="text-red-500">-{ws.main.diffStats.deletions}</span>
                <span className="text-gray-400 dark:text-gray-500">{ws.main.diffStats.filesChanged}f</span>
              </>
            )}
            {ws.main.lastSessionAt && ws.main.status !== "active" && ws.main.status !== "reviewing" && ws.main.status !== "fixing" && (
              <span className="text-gray-400 dark:text-gray-500">
                <RelativeTime timestamp={ws.main.lastSessionAt} prefix={ws.main.diffStats ? "· " : ""} />
              </span>
            )}
          </span>
          {ws.main.conflicts?.hasConflicts && ws.main.status !== "fixing" && (() => {
            const grouped = groupConflictsByRepo(ws.main.conflicts.conflictingFiles);
            const summary = formatConflictSummary(grouped);
            // Multi-repo (#81): when the conflict spans more than the leading repo, surface
            // the per-repo breakdown ("auth-svc 2, leading 1") inline; a single-repo conflict
            // keeps the compact "N files" label. Full breakdown is always in the tooltip.
            const multiRepo = grouped.groups.length > 1;
            return (
              <span
                className="order-last inline-flex items-center px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-medium shrink-0 max-w-full truncate"
                title={`Conflicts: ${summary}`}
              >
                {multiRepo
                  ? summary
                  : `${grouped.total} file${grouped.total !== 1 ? "s" : ""}`}
              </span>
            );
          })()}
          {ws.main.planMode && (
            <span className="order-last inline-flex items-center px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300 text-[10px] font-medium shrink-0">
              Plan Mode
            </span>
          )}
          {ws.main.planOnlyWarning && (
            <span className="order-last inline-flex items-center px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-400 text-[10px] font-medium shrink-0" title="Session completed but produced no file changes">
              No changes
            </span>
          )}
          {ws.main.profile?.provider && ws.main.profile.provider !== "claude" && (
            <span className={`order-last inline-flex items-center px-1 rounded font-medium text-[10px] shrink-0 ${
              ws.main.profile.provider === "copilot" ? "bg-emerald-50 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400" :
              ws.main.profile.provider === "codex" ? "bg-amber-50 dark:bg-amber-950 text-amber-600 dark:text-amber-400" :
              "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
            }`}>{ws.main.profile.provider === "copilot" ? "Copilot" : ws.main.profile.provider === "codex" ? "Codex" : ws.main.profile.provider}</span>
          )}
          {(ws.main.profile?.name ?? ws.main.claudeProfile) && (
            <span className="order-last inline-flex max-w-full items-center truncate px-1 rounded bg-brand-50 dark:bg-brand-900/40 text-brand-600 dark:text-brand-400 font-medium shrink">{ws.main.profile?.name ?? ws.main.claudeProfile}</span>
          )}
          {!ws.main.profile?.name && !ws.main.claudeProfile && ws.main.agentCommand && ws.main.agentCommand !== "claude" && (
            <span className="order-last inline-flex max-w-full items-center truncate px-1 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 font-mono text-[10px] shrink">{ws.main.agentCommand}</span>
          )}
          {ws.total > 1 && (
            <span className="order-last text-gray-400 dark:text-gray-500 shrink-0">+{ws.total - 1} more</span>
          )}
          <svg className="w-3 h-3 shrink-0 text-gray-300 dark:text-gray-600 group-hover/ws:text-brand-400 transition-colors ml-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
          </svg>
        </div>
      )}
      {!compact && (ws?.main?.status === "active" || ws?.main?.status === "fixing") && liveActivity && liveActivity !== "Delegating to agent" && (
        <div className="flex items-center gap-1.5 mt-1 text-xs text-gray-400 dark:text-gray-500 px-1">
          <span className={`inline-block w-1.5 h-1.5 rounded-full animate-pulse shrink-0 ${ws.main.status === "fixing" ? "bg-orange-400" : "bg-green-400"}`} />
          <span className="truncate">{liveActivity}</span>
        </div>
      )}
      {!compact && (ws?.main?.status === "active" || ws?.main?.status === "fixing") && liveActivity && liveStats && (
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-gray-400 dark:text-gray-500 px-1">
          {liveStats.model && <span className="font-mono">{liveStats.model}</span>}
          {liveStats.contextTokens > 0 && (
            <span>{Math.round(liveStats.contextTokens / 1000)}k ctx</span>
          )}
          {liveStats.toolUses > 0 && liveStats.contextTokens === 0 && (
            <span>{liveStats.toolUses} tools</span>
          )}
          {liveStats.subagentCount > 0 && (
            <span className="inline-flex items-center gap-0.5 px-1 rounded bg-brand-50 text-brand-600 dark:bg-brand-900/40 dark:text-brand-400 font-medium">
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              {liveStats.subagentCount}
            </span>
          )}
        </div>
      )}
      {!compact && !(ws?.main?.status === "active" || ws?.main?.status === "fixing") && ws?.main && (ws.main.contextTokens || ws.main.lastTool) && (
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-gray-400 dark:text-gray-500 px-1">
          {ws.main.contextTokens != null && ws.main.contextTokens > 0 && (
            <span>{Math.round(ws.main.contextTokens / 1000)}k ctx</span>
          )}
          {ws.main.lastTool && (
            <span className="font-mono truncate">{ws.main.lastTool}</span>
          )}
        </div>
      )}
    </>
  );
}
