import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import type { IssueWithStatus } from "@agentic-kanban/shared";

interface SprintCapacityPolicy {
  activeAgentsTarget: number;
  currentActive: number;
  availableSlots: number;
  maxNewStartsPerCycle: number;
  backlogFloor: number;
  currentBacklogSize: number;
  willStartCount: number;
}

interface SprintEligibleIssue {
  id: string;
  issueNumber: number | null;
  title: string;
  priority: string | null;
  statusName: string;
  blockers: string[];
  canStart: boolean;
}

interface SprintCapacityPlan {
  policy: SprintCapacityPolicy;
  nextEligibleIssues: SprintEligibleIssue[];
}

interface SprintCapacityPlannerProps {
  projectId: string;
  onIssueClick?: (issue: IssueWithStatus) => void;
}

function CapacityBar({ current, target, label }: { current: number; target: number; label: string }) {
  const pct = target > 0 ? Math.min(100, (current / target) * 100) : 0;
  const isFull = current >= target;
  const isOver = current > target;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
        <span>{label}</span>
        <span className={isOver ? "text-red-600 dark:text-red-400 font-medium" : ""}>
          {current}/{target}
        </span>
      </div>
      <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            isOver
              ? "bg-red-500"
              : isFull
              ? "bg-amber-500"
              : "bg-emerald-500"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function PriorityBadge({ priority }: { priority: string | null }) {
  if (!priority) return null;
  const colors: Record<string, string> = {
    critical: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    urgent: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    high: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
    medium: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
    low: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  };
  return (
    <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${colors[priority] ?? colors.low}`}>
      {priority}
    </span>
  );
}

export function SprintCapacityPlanner({ projectId }: SprintCapacityPlannerProps) {
  const [plan, setPlan] = useState<SprintCapacityPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await apiFetch<SprintCapacityPlan>(`/api/projects/${projectId}/sprint-capacity`);
        if (!cancelled) setPlan(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load capacity plan");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [projectId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-gray-400 dark:text-gray-500">
        Loading capacity plan...
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-xl py-8 text-center text-sm text-red-500 dark:text-red-400">
        {error}
      </div>
    );
  }

  if (!plan) return null;

  const { policy, nextEligibleIssues } = plan;
  const backlogHealthy = policy.currentBacklogSize >= policy.backlogFloor;
  const atCapacity = policy.availableSlots === 0;
  const startable = nextEligibleIssues.filter((i) => i.canStart);
  const blocked = nextEligibleIssues.filter((i) => !i.canStart);

  // Issues that would be launched in next monitor cycle
  const willStart = startable.slice(0, policy.willStartCount);
  const queued = startable.slice(policy.willStartCount);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 p-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Sprint Capacity Planner</h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Read-only policy view — edit targets in Strategic Targets (Strategy view).
          </p>
        </div>

        {/* Policy row */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800/60">
            <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{policy.activeAgentsTarget}</div>
            <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Agent target</div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800/60">
            <div className={`text-2xl font-bold ${atCapacity ? "text-amber-600 dark:text-amber-400" : "text-gray-900 dark:text-gray-100"}`}>
              {policy.currentActive}
            </div>
            <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Active now</div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800/60">
            <div className={`text-2xl font-bold ${policy.availableSlots > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-gray-400 dark:text-gray-500"}`}>
              {policy.availableSlots}
            </div>
            <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Open slots</div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800/60">
            <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{policy.maxNewStartsPerCycle}</div>
            <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Max per cycle</div>
          </div>
        </div>

        {/* Capacity bar + backlog health */}
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800/60 space-y-3">
          <h3 className="text-sm font-medium text-gray-800 dark:text-gray-200">Capacity</h3>
          <CapacityBar current={policy.currentActive} target={policy.activeAgentsTarget} label="Active agents" />
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>Backlog health (startable issues)</span>
              <span className={!backlogHealthy ? "text-amber-600 dark:text-amber-400 font-medium" : ""}>
                {policy.currentBacklogSize} / {policy.backlogFloor} floor
              </span>
            </div>
            <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${backlogHealthy ? "bg-blue-500" : "bg-amber-500"}`}
                style={{ width: `${Math.min(100, policy.backlogFloor > 0 ? (policy.currentBacklogSize / policy.backlogFloor) * 100 : 100)}%` }}
              />
            </div>
            {!backlogHealthy && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Backlog below floor — refill recommended ({policy.backlogFloor - policy.currentBacklogSize} more needed).
              </p>
            )}
          </div>
        </div>

        {/* Next cycle preview */}
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800/60 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-gray-800 dark:text-gray-200">Next Monitor Cycle Preview</h3>
            {policy.willStartCount > 0 ? (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                {policy.willStartCount} will launch
              </span>
            ) : (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                0 launches
              </span>
            )}
          </div>

          {willStart.length === 0 && queued.length === 0 && blocked.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-500">No backlog issues found.</p>
          ) : (
            <div className="space-y-1">
              {willStart.map((issue) => (
                <div
                  key={issue.id}
                  className="flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 dark:bg-emerald-900/20"
                >
                  <span className="text-emerald-600 dark:text-emerald-400 text-xs font-bold shrink-0">▶</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-gray-800 dark:text-gray-200">
                    {issue.issueNumber != null ? <span className="mr-1 text-xs text-gray-400">#{issue.issueNumber}</span> : null}
                    {issue.title}
                  </span>
                  <PriorityBadge priority={issue.priority} />
                  <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500">{issue.statusName}</span>
                </div>
              ))}

              {queued.length > 0 && (
                <>
                  <div className="pt-1 pb-0.5 text-xs text-gray-400 dark:text-gray-500">Queued (beyond cycle cap)</div>
                  {queued.map((issue) => (
                    <div
                      key={issue.id}
                      className="flex items-center gap-2 rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-700/30"
                    >
                      <span className="text-gray-400 dark:text-gray-500 text-xs shrink-0">·</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-gray-600 dark:text-gray-300">
                        {issue.issueNumber != null ? <span className="mr-1 text-xs text-gray-400">#{issue.issueNumber}</span> : null}
                        {issue.title}
                      </span>
                      <PriorityBadge priority={issue.priority} />
                      <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500">{issue.statusName}</span>
                    </div>
                  ))}
                </>
              )}

              {blocked.length > 0 && (
                <>
                  <div className="pt-1 pb-0.5 text-xs text-gray-400 dark:text-gray-500">Blocked</div>
                  {blocked.map((issue) => (
                    <div
                      key={issue.id}
                      className="rounded-md border border-gray-100 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-700/20"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-gray-300 dark:text-gray-600 text-xs shrink-0">⊘</span>
                        <span className="min-w-0 flex-1 truncate text-sm text-gray-500 dark:text-gray-400">
                          {issue.issueNumber != null ? <span className="mr-1 text-xs text-gray-400">#{issue.issueNumber}</span> : null}
                          {issue.title}
                        </span>
                        <PriorityBadge priority={issue.priority} />
                        <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500">{issue.statusName}</span>
                      </div>
                      {issue.blockers.length > 0 && (
                        <div className="mt-1 ml-5 space-y-0.5">
                          {issue.blockers.map((blocker, idx) => (
                            <p key={idx} className="text-xs text-amber-600 dark:text-amber-500">{blocker}</p>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
