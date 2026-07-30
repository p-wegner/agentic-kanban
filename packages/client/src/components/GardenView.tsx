import { useMemo } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";

export interface GardenViewProps {
  columns: StatusWithIssues[];
  onIssueClick: (issue: IssueWithStatus) => void;
  searchQuery?: string;
}

const GROWTH_STAGE: Record<string, { emoji: string; label: string; height: string }> = {
  "Todo": { emoji: "\u{1F331}", label: "Seedling", height: "h-6" },
  "In Progress": { emoji: "\u{1F33F}", label: "Sprouting", height: "h-10" },
  "In Review": { emoji: "\u{1F338}", label: "Budding", height: "h-14" },
  "Done": { emoji: "\u{1F33B}", label: "Blooming", height: "h-16" },
  "Cancelled": { emoji: "\u{1F940}", label: "Wilted", height: "h-6" },
};

const PRIORITY_COLOR: Record<string, string> = {
  critical: "bg-red-400",
  high: "bg-orange-400",
  medium: "bg-amber-400",
  low: "bg-emerald-400",
};

function stageFor(statusName: string): { emoji: string; label: string; height: string } {
  return GROWTH_STAGE[statusName] ?? { emoji: "\u{1F331}", label: statusName, height: "h-6" };
}

function PlantCard({
  issue,
  statusName,
  onClick,
}: {
  issue: IssueWithStatus;
  statusName: string;
  onClick: () => void;
}) {
  const stage = stageFor(statusName);
  const color = PRIORITY_COLOR[issue.priority ?? "low"] ?? PRIORITY_COLOR.low;

  return (
    <button
      onClick={onClick}
      title={`#${issue.issueNumber} ${issue.title} — ${stage.label}`}
      className="group flex flex-col items-center gap-1 w-20 shrink-0 focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-brand-500 rounded"
    >
      <span className="text-2xl leading-none transition-transform group-hover:scale-110">{stage.emoji}</span>
      <div className={`w-1 ${stage.height} rounded-full ${color} transition-all duration-500`} />
      <span className="text-[9px] font-mono text-gray-500 dark:text-gray-400">#{issue.issueNumber}</span>
      <span className="text-[9px] text-gray-600 dark:text-gray-300 line-clamp-1 max-w-[76px]">{issue.title}</span>
    </button>
  );
}

export function GardenView({ columns, onIssueClick, searchQuery = "" }: GardenViewProps) {
  const beds = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return columns.map((col) => ({
      name: col.name,
      issues: col.issues.filter(
        (issue) => !q || issue.title.toLowerCase().includes(q) || String(issue.issueNumber).includes(q),
      ),
    }));
  }, [columns, searchQuery]);

  const totalIssues = beds.reduce((n, b) => n + b.issues.length, 0);

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden bg-gradient-to-b from-sky-50 to-emerald-50 dark:from-gray-950 dark:to-emerald-950/20">
      <div className="flex items-center justify-between px-5 py-3 border-b border-emerald-200/60 dark:border-emerald-900/40 bg-white/70 dark:bg-gray-900/70 shrink-0">
        <div>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Garden</h2>
          <p className="text-[11px] text-gray-500 dark:text-gray-400">
            {totalIssues} issue{totalIssues !== 1 ? "s" : ""} growing across {beds.length} bed{beds.length !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 flex-col overflow-y-auto divide-y divide-emerald-200/50 dark:divide-emerald-900/30">
        {beds.map((bed) => (
          <div key={bed.name} className="flex min-h-[110px] shrink-0">
            <div className="flex flex-col items-center justify-start gap-1 pt-4 px-3 w-[80px] shrink-0 border-r border-emerald-200/50 dark:border-emerald-900/30 bg-white/50 dark:bg-gray-900/40">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400 text-center">
                {bed.name}
              </span>
              <span className="text-[10px] text-gray-400 dark:text-gray-600 font-mono">{bed.issues.length}</span>
            </div>

            <div className="flex-1 overflow-x-auto">
              {bed.issues.length === 0 ? (
                <div className="flex items-center justify-center h-full min-h-[90px]">
                  <span className="text-[11px] text-gray-400 dark:text-gray-600 opacity-60">Empty bed</span>
                </div>
              ) : (
                <div className="flex gap-3 px-4 py-3 items-end min-w-max">
                  {bed.issues.map((issue) => (
                    <PlantCard
                      key={issue.id}
                      issue={issue}
                      statusName={bed.name}
                      onClick={() => onIssueClick(issue)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
