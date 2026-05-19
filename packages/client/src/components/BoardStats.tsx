import { useEffect, useRef, useState } from "react";
import type { StatusWithIssues } from "@agentic-kanban/shared";

interface BoardStatsProps {
  activeColumns: StatusWithIssues[];
  archiveColumns: StatusWithIssues[];
  searchQuery: string;
  priorityFilter: string;
}

const COLUMN_COLORS: Record<string, string> = {
  "Todo": "bg-slate-400",
  "In Progress": "bg-amber-400",
  "In Review": "bg-blue-400",
  "Done": "bg-emerald-400",
  "Cancelled": "bg-gray-400",
};

const COLUMN_DOT_COLORS: Record<string, string> = {
  "Todo": "bg-slate-300",
  "In Progress": "bg-amber-300",
  "In Review": "bg-blue-300",
  "Done": "bg-emerald-300",
  "Cancelled": "bg-gray-300",
};

export function BoardStats({
  activeColumns,
  archiveColumns,
  searchQuery,
  priorityFilter,
}: BoardStatsProps) {
  const isFiltered = !!searchQuery || !!priorityFilter;
  const totalActive = activeColumns.reduce((sum, col) => sum + col.issues.length, 0);
  const totalArchive = archiveColumns.reduce((sum, col) => sum + col.issues.length, 0);
  const total = totalActive + totalArchive;

  const [prevTotal, setPrevTotal] = useState(total);
  const [popKey, setPopKey] = useState(0);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (prevTotal !== total) {
      setPrevTotal(total);
      setPopKey((k) => k + 1);
    }
  }, [total, prevTotal]);

  return (
    <div className="flex items-center gap-3 px-1 text-xs select-none">
      <div className="flex items-center gap-1.5">
        <span
          key={popKey}
          className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[11px] font-semibold text-white ${
            isFiltered ? "bg-violet-500" : "bg-gray-700"
          } ${popKey > 0 ? "count-pop" : ""}`}
        >
          {total}
        </span>
        <span className="text-gray-400 font-medium">
          {isFiltered ? "filtered" : "tickets"}
        </span>
      </div>

      <div className="h-3 w-px bg-gray-200" />

      <div className="flex items-center gap-2.5">
        {activeColumns.map((col) => (
          <div key={col.id} className="flex items-center gap-1">
            <span
              className={`w-2 h-2 rounded-full ${
                col.issues.length > 0
                  ? COLUMN_COLORS[col.name] ?? "bg-gray-400"
                  : COLUMN_DOT_COLORS[col.name] ?? "bg-gray-200"
              }`}
            />
            <span className="text-gray-500 hidden sm:inline">{col.name}</span>
            <span className="text-gray-400 font-medium sm:font-normal">
              {col.issues.length}
            </span>
          </div>
        ))}
      </div>

      {totalArchive > 0 && (
        <>
          <div className="h-3 w-px bg-gray-200" />
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-300" />
            <span className="text-gray-400">
              {totalArchive} done
            </span>
          </div>
        </>
      )}
    </div>
  );
}
