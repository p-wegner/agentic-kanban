import React, { useRef, useState } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import {
  groupByPriority,
  groupByTag,
  PRIORITY_LANE_STYLES,
} from "../lib/columnHelpers.js";
import type { CardDensity } from "../hooks/useBoardPreferences.js";

interface SwimlaneRendererProps {
  dimension: "priority" | "tag";
  issues: IssueWithStatus[];
  columnId: string;
  onDropWithLane?: (statusId: string, laneKey: string, sortOrder?: number) => void;
  cardDensity: CardDensity;
  renderIssueCard: (issue: IssueWithStatus) => React.ReactNode;
}

/** Renders the column's issues grouped into swimlanes (priority or tag).
 *  Consolidates what used to be two near-identical inline JSX branches: the only
 *  per-dimension differences are the grouping function and the lane header styling. */
export function SwimlaneRenderer({
  dimension,
  issues,
  columnId,
  onDropWithLane,
  cardDensity,
  renderIssueCard,
}: SwimlaneRendererProps) {
  const groups =
    dimension === "priority"
      ? groupByPriority(issues).map((group) => {
          const style = PRIORITY_LANE_STYLES[group.key] ?? PRIORITY_LANE_STYLES.ungrouped;
          return {
            key: group.key,
            label: style.label,
            dot: style.dot,
            dotColor: undefined as string | undefined,
            headerBg: style.headerBg,
            headerBorder: style.headerBorder,
            headerText: style.headerText,
            issues: group.issues,
          };
        })
      : groupByTag(issues).map((group) => ({
          key: group.key,
          label: group.label,
          dot: undefined as string | undefined,
          dotColor: group.color ?? undefined,
          headerBg: "bg-gray-50 dark:bg-gray-800/40",
          headerBorder: "border-gray-200 dark:border-gray-700",
          headerText: "text-gray-700 dark:text-gray-300",
          issues: group.issues,
        }));
  if (groups.length === 0) return null;
  return (
    <>
      {groups.map((group) => (
        <SwimLaneGroup
          key={group.key}
          laneKey={group.key}
          label={group.label}
          dot={group.dot}
          dotColor={group.dotColor}
          headerBg={group.headerBg}
          headerBorder={group.headerBorder}
          headerText={group.headerText}
          count={group.issues.length}
          columnId={columnId}
          onDropWithLane={onDropWithLane}
        >
          {group.issues.map((issue, idx) => (
            <div key={issue.id}>
              {renderIssueCard(issue)}
              {idx < group.issues.length - 1 && <div className={`${cardDensity === "compact" ? "mt-1" : "mt-1.5"}`} />}
            </div>
          ))}
        </SwimLaneGroup>
      ))}
    </>
  );
}

interface SwimLaneGroupProps {
  laneKey: string;
  label: string;
  dot?: string;
  dotColor?: string;
  headerBg: string;
  headerBorder: string;
  headerText: string;
  count: number;
  columnId: string;
  onDropWithLane?: (statusId: string, laneKey: string, sortOrder?: number) => void;
  children: React.ReactNode;
}

function SwimLaneGroup({
  laneKey,
  label,
  dot,
  dotColor,
  headerBg,
  headerBorder,
  headerText,
  count,
  columnId,
  onDropWithLane,
  children,
}: SwimLaneGroupProps) {
  const [laneExpanded, setLaneExpanded] = useState(true);
  const [laneDragOver, setLaneDragOver] = useState(false);
  const laneCounterRef = useRef(0);

  function handleLaneDragEnter(e: React.DragEvent) {
    e.preventDefault();
    laneCounterRef.current++;
    setLaneDragOver(true);
  }

  function handleLaneDragLeave() {
    laneCounterRef.current--;
    if (laneCounterRef.current === 0) setLaneDragOver(false);
  }

  function handleLaneDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function handleLaneDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    laneCounterRef.current = 0;
    setLaneDragOver(false);
    onDropWithLane?.(columnId, laneKey);
  }

  return (
    <div
      className={`rounded-lg border ${headerBorder} mb-1.5 overflow-hidden transition-all ${laneDragOver ? "ring-2 ring-brand-400 ring-offset-1" : ""}`}
      onDragEnter={onDropWithLane ? handleLaneDragEnter : undefined}
      onDragLeave={onDropWithLane ? handleLaneDragLeave : undefined}
      onDragOver={onDropWithLane ? handleLaneDragOver : undefined}
      onDrop={onDropWithLane ? handleLaneDrop : undefined}
    >
      <button
        type="button"
        onClick={() => setLaneExpanded((v) => !v)}
        className={`flex w-full items-center gap-1.5 px-2 py-1 ${headerBg} transition-colors hover:brightness-95`}
        aria-expanded={laneExpanded}
      >
        {dot ? (
          <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
        ) : dotColor ? (
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dotColor }} />
        ) : (
          <span className="w-2 h-2 rounded-full shrink-0 bg-gray-400" />
        )}
        <span className={`text-[10px] font-bold uppercase tracking-wider ${headerText}`}>{label}</span>
        <span className={`ml-auto text-[10px] font-mono ${headerText} opacity-70`}>{count}</span>
        <svg
          className={`w-3 h-3 ${headerText} transition-transform shrink-0 ${laneExpanded ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {laneExpanded && (
        <div className="p-1.5 space-y-1.5">
          {children}
        </div>
      )}
    </div>
  );
}

export function DropGap({
  visible,
  onDrop,
}: {
  visible: boolean;
  onDrop: (e: React.DragEvent) => void;
}) {
  if (!visible) return null;
  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      className="h-1 rounded bg-brand-400/50 my-1"
    />
  );
}
