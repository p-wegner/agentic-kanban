// The "Workspaces" block of IssueDetailPanel (view mode). Extracted to shrink the
// panel's god-render and to collapse the status→style switch that was duplicated
// three times inline (dot colour, badge colour, badge label) into pure helpers.
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { WorkflowProgress } from "./WorkflowProgress.js";
import { isSpecPlanningPhase, SpecPhasePanel } from "./SpecPhasePanel.js";

/** The non-null main workspace summary carried on an issue. */
type MainWorkspace = NonNullable<NonNullable<IssueWithStatus["workspaceSummary"]>["main"]>;

/** Status indicator dot colour for a workspace. */
export function workspaceStatusDotClass(main: MainWorkspace): string {
  if (main.status === "active") return "bg-green-500";
  if (main.status === "reviewing") return "bg-accent-500 animate-pulse";
  if (main.status === "fixing") return "bg-orange-500 animate-pulse";
  if (main.status === "error") return "bg-red-500";
  if (main.conflicts?.hasConflicts) return "bg-red-500";
  if (main.status === "idle") return "bg-amber-500";
  return "bg-gray-400";
}

/** Status pill background/text colour for a workspace. */
export function workspaceStatusBadgeClass(main: MainWorkspace): string {
  if (main.status === "active") return "bg-green-100 text-green-700";
  if (main.status === "reviewing") return "bg-accent-50 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300";
  if (main.status === "fixing") return "bg-orange-100 text-orange-700";
  if (main.status === "error") return "bg-red-100 text-red-700";
  if (main.conflicts?.hasConflicts) return "bg-red-100 text-red-700";
  if (main.status === "idle") return "bg-amber-100 text-amber-700";
  if (main.status === "closed" && main.lastSessionTriggerType === "fix-conflicts") return "bg-orange-100 text-orange-700";
  return "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400";
}

/** Human-readable status label for a workspace pill. */
export function workspaceStatusLabel(main: MainWorkspace): string {
  if (main.status === "reviewing") return "AI Reviewing";
  if (main.status === "fixing") return "AI Fixing Conflicts";
  if (main.status === "error") return "Preflight Error";
  if (main.conflicts?.hasConflicts) return "Merge Conflicts";
  if (main.status === "closed" && main.lastSessionTriggerType === "fix-conflicts") return "merged conflicts";
  return main.status;
}

interface IssueWorkspacesSectionProps {
  issue: IssueWithStatus;
  workspaceCount: number;
  onManageWorkspaces: (issue: IssueWithStatus, workspaceId?: string, sessionId?: string) => void;
  onStartWorkspace?: (issue: IssueWithStatus) => void;
  onIssueUpdate: (issue: IssueWithStatus) => void;
  onShowCompareAttempts: () => void;
  onShowShowdown: () => void;
}

export function IssueWorkspacesSection({
  issue,
  workspaceCount,
  onManageWorkspaces,
  onStartWorkspace,
  onIssueUpdate,
  onShowCompareAttempts,
  onShowShowdown,
}: IssueWorkspacesSectionProps) {
  const main = issue.workspaceSummary?.main;
  return (
    <div>
      <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1">
        Workspaces
      </label>
      {main ? (
        <div className="flex flex-col gap-1">
          <button
            onClick={() => onManageWorkspaces(issue, main.id)}
            className={`w-full flex flex-col gap-1 p-2 rounded border transition-colors text-left ${
              main.conflicts?.hasConflicts
                ? "border-red-200 dark:border-red-800 hover:border-red-300 dark:hover:border-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                : "border-gray-200 dark:border-gray-700 hover:border-brand-300 dark:hover:border-brand-600 hover:bg-brand-50 dark:hover:bg-brand-950"
            }`}
          >
            <div className="flex items-center gap-2 w-full">
              <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${workspaceStatusDotClass(main)}`} />
              <span className="text-sm font-mono text-gray-700 dark:text-gray-300 truncate">{main.branch}</span>
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${workspaceStatusBadgeClass(main)}`}>
                {workspaceStatusLabel(main)}
              </span>
              {main.conflicts?.hasConflicts && main.status !== "fixing" && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-medium shrink-0">
                  {main.conflicts.conflictingFiles.length} file{main.conflicts.conflictingFiles.length !== 1 ? "s" : ""}
                </span>
              )}
              {issue.workspaceSummary!.total > 1 && (
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); onShowCompareAttempts(); }}
                  className="ml-auto text-xs text-blue-600 dark:text-blue-400 hover:underline shrink-0"
                  title={`Compare all ${issue.workspaceSummary!.total} attempts`}
                >
                  +{issue.workspaceSummary!.total - 1} more
                </button>
              )}
            </div>
            {(main.status === "active" || main.status === "fixing") && (main.contextTokens || main.lastTool) && (
              <div className="flex items-center gap-2 pl-4">
                {main.contextTokens ? (
                  <span className="text-[10px] text-gray-400 dark:text-gray-500">
                    {main.contextTokens >= 1000
                      ? `${Math.round(main.contextTokens / 1000)}k ctx`
                      : `${main.contextTokens} ctx`}
                  </span>
                ) : null}
                {main.lastTool ? (
                  <span className="text-[10px] text-gray-400 dark:text-gray-500 truncate" title={main.lastTool}>
                    {main.lastTool}
                  </span>
                ) : null}
              </div>
            )}
          </button>
          {main.conflicts?.hasConflicts && (
            <button
              onClick={() => onManageWorkspaces(issue, main.id)}
              className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded bg-red-600 text-white hover:bg-red-700 transition-colors self-start"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              Fix with AI
            </button>
          )}
          <WorkflowProgress
            workspaceId={main.id}
            projectId={issue.projectId}
            workspaceStatus={main.mergedAt ? "merged" : main.status}
          />
          {isSpecPlanningPhase(main.workflow?.currentNodeName) && (
            <SpecPhasePanel
              issue={issue}
              workspace={main}
              onApproved={() => onIssueUpdate(issue)}
            />
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          {onStartWorkspace && (
            <button
              onClick={() => onStartWorkspace(issue)}
              className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Start Workspace
            </button>
          )}
          <button
            onClick={onShowShowdown}
            className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
            title="Run this ticket with different skill/model combos in parallel"
          >
            ⚔️ Showdown…
          </button>
          <button
            onClick={() => onManageWorkspaces(issue)}
            className="text-sm text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300"
          >
            {workspaceCount === 0 ? "Custom options..." : "View Workspaces"}
          </button>
        </div>
      )}
    </div>
  );
}
