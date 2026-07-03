import type { MilestoneResponse, StatusWithIssues } from "@agentic-kanban/shared";
import { useBoardFilterStore } from "../stores/boardFilterStore.js";

/** Milestone progress banner shown above the kanban board when a milestone filter is active. */
export function MilestoneFilterBanner({
  milestones,
  columns,
}: {
  milestones: MilestoneResponse[];
  columns: StatusWithIssues[];
}) {
  // Filter slice (#958): read/clear the milestone filter via the store instead
  // of milestoneId/onClear props; renders nothing while no filter is active.
  const milestoneId = useBoardFilterStore((s) => s.milestoneFilterId);
  const setMilestoneFilterId = useBoardFilterStore((s) => s.setMilestoneFilterId);
  const onClear = () => setMilestoneFilterId(null);
  if (!milestoneId) return null;
  const activeMilestone = milestones.find(m => m.id === milestoneId);
  if (!activeMilestone) return null;
  const allMilestoneIssues = columns.flatMap(c => c.issues).filter(i => i.milestoneId === milestoneId);
  const doneCount = allMilestoneIssues.filter(i => i.statusName === "Done").length;
  const total = allMilestoneIssues.length;
  return (
    <div className="mx-4 mb-2 flex items-center gap-3 px-3 py-2 rounded-md bg-violet-50 dark:bg-violet-950/40 border border-violet-200 dark:border-violet-800 text-sm">
      <svg className="w-4 h-4 text-violet-600 dark:text-violet-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 21V3l18 9-18 9z" />
      </svg>
      <span className="font-medium text-violet-800 dark:text-violet-200">{activeMilestone.name}</span>
      {activeMilestone.dueDate && (
        <span className="text-xs text-violet-600 dark:text-violet-400">
          due {new Date(activeMilestone.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
      )}
      <span className="ml-auto text-violet-700 dark:text-violet-300 font-medium">
        {doneCount}/{total} done
      </span>
      {total > 0 && (
        <div className="w-24 h-1.5 rounded-full bg-violet-200 dark:bg-violet-800 overflow-hidden">
          <div
            className="h-full bg-violet-600 dark:bg-violet-400 rounded-full transition-all"
            style={{ width: `${Math.round((doneCount / total) * 100)}%` }}
          />
        </div>
      )}
      <button
        onClick={onClear}
        title="Clear milestone filter"
        className="text-violet-500 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-200 ml-1"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
