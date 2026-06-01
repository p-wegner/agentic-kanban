import type { IssueWithStatus, MainWorkspaceInfo, StatusWithIssues } from "@agentic-kanban/shared";

export interface RunQueueForecastStart {
  issue: IssueWithStatus;
  slotLabel: string;
  sourceLabel: string;
}

export interface RunQueueForecast {
  activeTarget: number;
  runningCount: number;
  idleCount: number;
  reviewCount: number;
  pendingMergeCount: number;
  openSlots: number;
  nextStarts: RunQueueForecastStart[];
}

interface SlotCandidate {
  label: string;
  timestamp: number;
}

interface StartCandidate {
  issue: IssueWithStatus;
  rank: number;
}

interface RunQueueForecastPanelProps {
  columns: StatusWithIssues[];
  activeTarget: string | number;
  onClose: () => void;
  onIssueClick: (issue: IssueWithStatus) => void;
}

const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function parseActiveTarget(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

function isRunningStatus(status: MainWorkspaceInfo["status"]): boolean {
  return status === "active" || status === "fixing";
}

function isReviewStatus(status: MainWorkspaceInfo["status"]): boolean {
  return status === "reviewing";
}

function isIdleCapacityStatus(status: MainWorkspaceInfo["status"]): boolean {
  return status === "idle" || status === "awaiting-plan-approval" || status === "error";
}

function hasOpenWorkspace(issue: IssueWithStatus): boolean {
  const workspace = issue.workspaceSummary?.main;
  return Boolean(workspace && workspace.status !== "closed");
}

function isStartableIssue(issue: IssueWithStatus): boolean {
  if (issue.isBlocked) return false;
  if (hasOpenWorkspace(issue)) return false;
  return issue.statusName === "Todo" || issue.statusName === "Backlog";
}

function sortIssuesForStart(a: StartCandidate, b: StartCandidate): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const priorityDelta = (PRIORITY_RANK[a.issue.priority] ?? 99) - (PRIORITY_RANK[b.issue.priority] ?? 99);
  if (priorityDelta !== 0) return priorityDelta;
  if (a.issue.sortOrder !== b.issue.sortOrder) return a.issue.sortOrder - b.issue.sortOrder;
  const aUpdated = new Date(a.issue.updatedAt).getTime();
  const bUpdated = new Date(b.issue.updatedAt).getTime();
  return aUpdated - bUpdated;
}

function slotTimestamp(issue: IssueWithStatus, workspace: MainWorkspaceInfo): number {
  const source = workspace.lastSessionAt ?? issue.statusChangedAt ?? issue.updatedAt;
  const timestamp = source ? new Date(source).getTime() : Date.now();
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function slotLabel(issue: IssueWithStatus, workspace: MainWorkspaceInfo): string {
  const issueLabel = issue.issueNumber ? `#${issue.issueNumber}` : issue.title;
  if (workspace.readyForMerge) return `${issueLabel} merges`;
  if (workspace.status === "reviewing") return `${issueLabel} review finishes`;
  if (workspace.status === "fixing") return `${issueLabel} conflict fix finishes`;
  return `${issueLabel} agent finishes`;
}

export function buildRunQueueForecast(columns: StatusWithIssues[], activeTargetInput: string | number): RunQueueForecast {
  const activeTarget = parseActiveTarget(activeTargetInput);
  const allIssues = columns.flatMap((column) => column.issues);
  const openWorkspaces = allIssues
    .map((issue) => ({ issue, workspace: issue.workspaceSummary?.main }))
    .filter((entry): entry is { issue: IssueWithStatus; workspace: MainWorkspaceInfo } =>
      Boolean(entry.workspace && entry.workspace.status !== "closed")
    );

  const runningCount = openWorkspaces.filter(({ workspace }) => isRunningStatus(workspace.status)).length;
  const reviewCount = openWorkspaces.filter(({ workspace }) => isReviewStatus(workspace.status)).length;
  const idleCount = openWorkspaces.filter(({ workspace }) => isIdleCapacityStatus(workspace.status)).length;
  const pendingMergeCount = openWorkspaces.filter(({ issue, workspace }) =>
    issue.statusName === "In Review" || workspace.readyForMerge === true
  ).length;
  const occupiedSlots = runningCount + reviewCount;
  const openSlots = Math.max(0, activeTarget - occupiedSlots);

  const startCandidates = allIssues
    .map((issue) => ({
      issue,
      rank: issue.statusName === "Todo" ? 0 : 1,
    }))
    .filter((candidate) => isStartableIssue(candidate.issue))
    .sort(sortIssuesForStart);

  const immediateSlots: SlotCandidate[] = Array.from({ length: openSlots }, (_, index) => ({
    label: index === 0 ? "open slot now" : `open slot ${index + 1} now`,
    timestamp: 0,
  }));

  const futureSlots = openWorkspaces
    .filter(({ workspace }) => isRunningStatus(workspace.status) || isReviewStatus(workspace.status))
    .map(({ issue, workspace }) => ({
      label: slotLabel(issue, workspace),
      timestamp: slotTimestamp(issue, workspace),
    }))
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.label.localeCompare(b.label);
    });

  const slots = [...immediateSlots, ...futureSlots];
  const nextStarts = startCandidates.slice(0, 2).map((candidate, index) => {
    const slot = slots[index];
    return {
      issue: candidate.issue,
      slotLabel: slot?.label ?? "after current queue clears",
      sourceLabel: slot ? "capacity forecast" : "waiting for capacity",
    };
  });

  return {
    activeTarget,
    runningCount,
    idleCount,
    reviewCount,
    pendingMergeCount,
    openSlots,
    nextStarts,
  };
}

function CountTile({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`rounded border px-3 py-2 ${tone}`}>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] font-medium uppercase text-current/70">{label}</div>
    </div>
  );
}

export function RunQueueForecastPanel({ columns, activeTarget, onClose, onIssueClick }: RunQueueForecastPanelProps) {
  const forecast = buildRunQueueForecast(columns, activeTarget);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-[min(560px,100vw)] bg-surface-raised dark:bg-surface-raised-dark shadow-xl flex flex-col animate-slide-in-right">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 min-w-0">
            <svg className="w-5 h-5 text-sky-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 18V6m4 12V9m4 9v-5m4 5V4m4 14v-7" />
            </svg>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-ink dark:text-stone-100 heading-serif">Run Queue Forecast</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">Read-only capacity from current board workspaces</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
            aria-label="Close run queue forecast"
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          <section>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <CountTile label="Active target" value={forecast.activeTarget} tone="border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300" />
              <CountTile label="Running" value={forecast.runningCount} tone="border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300" />
              <CountTile label="Idle" value={forecast.idleCount} tone="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300" />
              <CountTile label="Review" value={forecast.reviewCount} tone="border-accent-200 bg-accent-50 text-accent-700 dark:border-accent-900 dark:bg-accent-950/40 dark:text-accent-300" />
              <CountTile label="Pending merge" value={forecast.pendingMergeCount} tone="border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-300" />
              <CountTile label="Open slots" value={forecast.openSlots} tone="border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300" />
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Next likely starts</h3>
              <span className="text-xs text-gray-400 dark:text-gray-500">{forecast.nextStarts.length}/2</span>
            </div>
            {forecast.nextStarts.length === 0 ? (
              <div className="rounded border border-gray-200 dark:border-gray-700 px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                No startable Todo or Backlog issues are waiting for capacity.
              </div>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-gray-800 rounded border border-gray-200 dark:border-gray-700 overflow-hidden">
                {forecast.nextStarts.map((start, index) => (
                  <button
                    key={start.issue.id}
                    type="button"
                    onClick={() => {
                      onIssueClick(start.issue);
                      onClose();
                    }}
                    className="w-full px-3 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-xs font-mono text-gray-400 dark:text-gray-500 mt-0.5 shrink-0">{index + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-xs font-mono text-gray-400 dark:text-gray-500 shrink-0">#{start.issue.issueNumber}</span>
                          <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{start.issue.title}</span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 flex-wrap">
                          <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300">{start.issue.statusName}</span>
                          <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300">{start.issue.priority}</span>
                          <span className="text-xs text-gray-500 dark:text-gray-400">{start.slotLabel}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
