import { useCallback, useRef, useState } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import type { LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";
import { IssueCard, type ProjectTag, type QuickUpdateCallbacks } from "./IssueCard.js";
import { evaluateWipLimit } from "../lib/wipLimits.js";
import { computeDropSortOrder } from "../lib/reorderIssues.js";
import type { CardDensity } from "../hooks/useBoardPreferences.js";

export type SwimlaneDimension = "none" | "priority" | "tag";

const ESTIMATE_POINTS: Record<string, number> = { XS: 1, S: 2, M: 3, L: 5, XL: 8 };

const PRIORITY_LANE_ORDER = ["critical", "high", "medium", "low", "ungrouped"];
const PRIORITY_LANE_STYLES: Record<string, { label: string; headerBg: string; headerBorder: string; headerText: string; dot: string }> = {
  critical: { label: "Critical", headerBg: "bg-red-50 dark:bg-red-950/40", headerBorder: "border-red-200 dark:border-red-800", headerText: "text-red-700 dark:text-red-400", dot: "bg-red-500" },
  high: { label: "High", headerBg: "bg-orange-50 dark:bg-orange-950/40", headerBorder: "border-orange-200 dark:border-orange-800", headerText: "text-orange-700 dark:text-orange-400", dot: "bg-orange-500" },
  medium: { label: "Medium", headerBg: "bg-yellow-50 dark:bg-yellow-950/40", headerBorder: "border-yellow-200 dark:border-yellow-800", headerText: "text-yellow-700 dark:text-yellow-400", dot: "bg-yellow-400" },
  low: { label: "Low", headerBg: "bg-slate-50 dark:bg-slate-800/40", headerBorder: "border-slate-200 dark:border-slate-700", headerText: "text-slate-600 dark:text-slate-400", dot: "bg-slate-400" },
  ungrouped: { label: "Ungrouped", headerBg: "bg-gray-50 dark:bg-gray-800/40", headerBorder: "border-gray-200 dark:border-gray-700", headerText: "text-gray-500 dark:text-gray-400", dot: "bg-gray-400" },
};

function groupByPriority(issues: IssueWithStatus[]): { key: string; issues: IssueWithStatus[] }[] {
  const groups: Record<string, IssueWithStatus[]> = {};
  for (const key of PRIORITY_LANE_ORDER) groups[key] = [];
  for (const issue of issues) {
    const p = issue.priority && PRIORITY_LANE_ORDER.includes(issue.priority) ? issue.priority : "ungrouped";
    groups[p].push(issue);
  }
  return PRIORITY_LANE_ORDER.map((key) => ({ key, issues: groups[key] })).filter((g) => g.issues.length > 0);
}

function groupByTag(issues: IssueWithStatus[]): { key: string; label: string; color: string | null; issues: IssueWithStatus[] }[] {
  const tagGroups: Map<string, { label: string; color: string | null; issues: IssueWithStatus[] }> = new Map();
  const ungrouped: IssueWithStatus[] = [];
  for (const issue of issues) {
    const tags = issue.tags ?? [];
    if (tags.length === 0) {
      ungrouped.push(issue);
    } else {
      for (const tag of tags) {
        if (!tagGroups.has(tag.id)) {
          tagGroups.set(tag.id, { label: tag.name, color: tag.color, issues: [] });
        }
        tagGroups.get(tag.id)!.issues.push(issue);
      }
    }
  }
  const result: { key: string; label: string; color: string | null; issues: IssueWithStatus[] }[] = [];
  for (const [key, g] of tagGroups) result.push({ key, ...g });
  result.sort((a, b) => a.label.localeCompare(b.label));
  if (ungrouped.length > 0) result.push({ key: "ungrouped", label: "Ungrouped", color: null, issues: ungrouped });
  return result;
}

function computeColumnEstimate(issues: IssueWithStatus[]): { total: number; unestimated: number } {
  let total = 0;
  let unestimated = 0;
  for (const issue of issues) {
    if (issue.estimate && ESTIMATE_POINTS[issue.estimate] != null) {
      total += ESTIMATE_POINTS[issue.estimate];
    } else {
      unestimated++;
    }
  }
  return { total, unestimated };
}

type SortMode = "default" | "type";

const ISSUE_TYPE_ORDER: Record<string, number> = {
  bug: 0,
  feature: 1,
  task: 2,
  chore: 3,
};

function sortIssues(issues: IssueWithStatus[], mode: SortMode): IssueWithStatus[] {
  if (mode === "default") return issues;
  return [...issues].sort(
    (a, b) =>
      (ISSUE_TYPE_ORDER[a.issueType ?? "task"] ?? 2) - (ISSUE_TYPE_ORDER[b.issueType ?? "task"] ?? 2)
  );
}

const VALID_SORT_MODES = new Set<string>(["default", "type"]);

function loadSortMode(columnId: string): SortMode {
  try {
    const stored = localStorage.getItem(`col-sort-${columnId}`);
    return (stored && VALID_SORT_MODES.has(stored) ? stored : "default") as SortMode;
  } catch {
    return "default";
  }
}

interface BoardColumnProps {
  column: StatusWithIssues;
  allColumns?: StatusWithIssues[];
  projectId: string;
  creatingInColumn: string | null;
  onCreateClick: (statusId: string) => void;
  onCreateCancel: () => void;
  onIssueClick: (issue: IssueWithStatus, event: React.MouseEvent) => void;
  onWorkspaceClick?: (issue: IssueWithStatus, workspaceId?: string) => void;
  onStartWorkspace?: (issue: IssueWithStatus) => void;
  onDryRun?: (issue: IssueWithStatus) => void;
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  onDrop: (statusId: string, sortOrder?: number) => void;
  onDuplicate?: (issue: IssueWithStatus) => void;
  onMoveToNext?: (issue: IssueWithStatus, nextStatusId: string) => void;
  onDeleteIssue?: (issueId: string) => void;
  searchQuery?: string;
  sessionActivity?: Record<string, string>;
  liveStats?: Record<string, LiveSessionStats>;
  sessionTodos?: Record<string, TodoItem[]>;
  pendingIssueIds?: Set<string>;
  pendingWorkspaceIssueIds?: Set<string>;
  selectedIssueIds?: Set<string>;
  keyboardCursorIssueId?: string | null;
  allProjectTags?: ProjectTag[];
  quickUpdate?: QuickUpdateCallbacks;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  width?: number;
  /** Mobile vertical-stack mode: full-width, auto-height (no internal scroll) so
   *  the board scrolls through all columns instead of one full-height column. */
  stacked?: boolean;
  onResizeStart?: (e: React.MouseEvent) => void;
  onResizeReset?: () => void;
  wipLimit?: number | null;
  onSetWipLimit?: (statusId: string, limit: number | null) => void;
  cardDensity?: CardDensity;
  onColumnDragStart?: (e: React.DragEvent) => void;
  onColumnDragOver?: (e: React.DragEvent) => void;
  onColumnDragLeave?: () => void;
  onColumnDrop?: (e: React.DragEvent) => void;
  onColumnDragEnd?: () => void;
  isColumnDragOver?: boolean;
  swimlaneDimension?: SwimlaneDimension;
  onDropWithLane?: (statusId: string, laneKey: string, sortOrder?: number) => void;
  showAgingHeatmap?: boolean;
  agingWarmDays?: number;
  agingHotDays?: number;
}

const ARCHIVE_STATUS_NAMES = new Set(["Done", "Cancelled"]);

export function BoardColumn({
  column,
  allColumns,
  projectId,
  creatingInColumn,
  onCreateClick,
  onCreateCancel,
  onIssueClick,
  onWorkspaceClick,
  onStartWorkspace,
  onDryRun,
  onDragStart,
  onDrop,
  onDuplicate,
  onMoveToNext,
  onDeleteIssue,
  searchQuery,
  sessionActivity,
  liveStats,
  sessionTodos,
  pendingIssueIds,
  pendingWorkspaceIssueIds,
  selectedIssueIds,
  keyboardCursorIssueId,
  allProjectTags,
  quickUpdate,
  children,
  style,
  width,
  stacked = false,
  onResizeStart,
  onResizeReset,
  wipLimit,
  onSetWipLimit,
  cardDensity = "comfortable",
  onColumnDragStart,
  onColumnDragOver,
  onColumnDragLeave,
  onColumnDrop,
  onColumnDragEnd,
  isColumnDragOver = false,
  swimlaneDimension = "none",
  onDropWithLane,
  showAgingHeatmap = false,
  agingWarmDays = 3,
  agingHotDays = 7,
}: BoardColumnProps) {
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState<"top" | "middle" | "bottom" | "none">("none");
  const [sortMode, setSortMode] = useState<SortMode>(() => loadSortMode(column.id));

  const nextStatus = allColumns && !ARCHIVE_STATUS_NAMES.has(column.name)
    ? (() => {
        const sorted = [...allColumns].sort((a, b) => a.sortOrder - b.sortOrder);
        const idx = sorted.findIndex((c) => c.id === column.id);
        return idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null;
      })()
    : null;

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const atTop = scrollTop <= 2;
    const atBottom = scrollTop + clientHeight >= scrollHeight - 2;
    if (scrollHeight <= clientHeight + 4) {
      setScrollState("none");
    } else if (atTop && !atBottom) {
      setScrollState("top");
    } else if (atBottom && !atTop) {
      setScrollState("bottom");
    } else {
      setScrollState("middle");
    }
  }, []);

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current++;
    setDragOver(true);
  }

  function handleDragLeave() {
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setDragOver(false);
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragOver(false);
    onDrop(column.id);
  }

  function handleDropGap(e: React.DragEvent, sortOrder: number) {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setDragOver(false);
    onDrop(column.id, sortOrder);
  }

  function computeGapSortOrder(beforeIndex: number): number {
    return computeDropSortOrder(
      displayedIssues.map((i) => i.sortOrder),
      beforeIndex,
    );
  }

  function toggleSort() {
    const next: SortMode = sortMode === "default" ? "type" : "default";
    setSortMode(next);
    try {
      localStorage.setItem(`col-sort-${column.id}`, next);
    } catch {
      // ignore
    }
  }

  const [editingWipLimit, setEditingWipLimit] = useState(false);
  const [wipLimitInput, setWipLimitInput] = useState("");

  function startEditWipLimit() {
    setWipLimitInput(wipLimit != null ? String(wipLimit) : "");
    setEditingWipLimit(true);
  }

  function commitWipLimit() {
    setEditingWipLimit(false);
    if (!onSetWipLimit) return;
    const trimmed = wipLimitInput.trim();
    if (!trimmed) {
      onSetWipLimit(column.id, null);
    } else {
      const parsed = parseInt(trimmed, 10);
      onSetWipLimit(column.id, Number.isFinite(parsed) && parsed > 0 ? parsed : null);
    }
  }

  function handleWipLimitKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") commitWipLimit();
    if (e.key === "Escape") setEditingWipLimit(false);
  }

  const isCreating = creatingInColumn === column.id;
  const displayedIssues = sortIssues(column.issues, sortMode);
  const wipStatus = evaluateWipLimit(column.issues.length, wipLimit ?? null);
  const estimateRollup = computeColumnEstimate(column.issues);

  const columnStyle: React.CSSProperties = width != null
    ? { width, minWidth: 160, maxWidth: 800, flexShrink: 0, ...style }
    : style ?? {};

  return (
    <div style={{ display: "contents" }}>
    <div
      id={`column-${column.id}`}
      className={`${stacked ? "w-full shrink-0" : width != null ? "" : "w-[calc(100vw-2rem)] sm:w-72 shrink-0"} bg-surface-sunken dark:bg-surface-sunken-dark rounded-xl p-2 flex flex-col transition-all relative ${
        dragOver ? "ring-2 ring-brand-400 ring-offset-1 ring-offset-surface dark:ring-offset-surface-dark" : ""
      } ${isColumnDragOver ? "ring-2 ring-brand-300 ring-offset-1 ring-offset-surface dark:ring-offset-surface-dark opacity-75" : ""}`}
      style={columnStyle}
      onDragEnter={handleDragEnter}
      onDragLeave={(e) => { handleDragLeave(); onColumnDragLeave?.(); }}
      onDragOver={(e) => { handleDragOver(e); onColumnDragOver?.(e); }}
      onDrop={(e) => { handleDrop(e); onColumnDrop?.(e); }}
      onDragEnd={onColumnDragEnd}
    >
      <div className={`flex items-center justify-between mb-2 px-1 shrink-0 rounded-lg transition-colors ${wipStatus === "over" ? "bg-red-50/60 dark:bg-red-900/20" : ""}`}>
        <div className="flex items-start gap-1">
          {onColumnDragStart && (
            <div
              draggable
              onDragStart={onColumnDragStart}
              className="mt-0.5 cursor-grab active:cursor-grabbing text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 transition-colors shrink-0"
              title="Drag to reorder column"
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16">
                <circle cx="5" cy="4" r="1.2"/><circle cx="11" cy="4" r="1.2"/>
                <circle cx="5" cy="8" r="1.2"/><circle cx="11" cy="8" r="1.2"/>
                <circle cx="5" cy="12" r="1.2"/><circle cx="11" cy="12" r="1.2"/>
              </svg>
            </div>
          )}
        <div className="flex flex-col gap-0.5">
          <h2 className="font-semibold text-sm text-ink-soft dark:text-gray-300 flex items-center gap-2 tracking-tight">
            {column.name}
            {editingWipLimit ? (
              <input
                autoFocus
                type="number"
                min="1"
                value={wipLimitInput}
                onChange={(e) => setWipLimitInput(e.target.value)}
                onBlur={commitWipLimit}
                onKeyDown={handleWipLimitKeyDown}
                placeholder="limit"
                className="w-14 text-[11px] rounded px-1 py-0.5 border border-brand-300 dark:border-brand-600 bg-white dark:bg-gray-800 text-ink dark:text-gray-100 outline-none"
              />
            ) : (
              <span
                className={`text-[11px] rounded-full px-2 py-0.5 font-medium shadow-sm ${
                  wipStatus === "over"
                    ? "bg-red-100 dark:bg-red-900/60 text-red-600 dark:text-red-400"
                    : "bg-surface-raised/80 dark:bg-gray-900/80 text-ink-faint dark:text-gray-500"
                }`}
              >
                {wipLimit != null ? `${column.issues.length} / ${wipLimit}` : column.issues.length}
              </span>
            )}
          </h2>
          {column.name === "AI Reviewed" && (
            <span className="text-[10px] text-accent-700 dark:text-accent-300 font-medium">Awaiting manual merge</span>
          )}
          {column.issues.length > 0 && (
            <span className="text-[10px] text-ink-faint dark:text-gray-500">
              {estimateRollup.total > 0 ? `${estimateRollup.total} pts` : ""}
              {estimateRollup.total > 0 && estimateRollup.unestimated > 0 ? " · " : ""}
              {estimateRollup.unestimated > 0 ? `${estimateRollup.unestimated} unestimated` : ""}
            </span>
          )}
        </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={toggleSort}
            className={`text-xs rounded-md px-1.5 py-0.5 transition-colors ${
              sortMode === "type"
                ? "bg-brand-100 text-brand-600 hover:bg-brand-200"
                : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-white/60 dark:hover:bg-gray-800/60"
            }`}
            title={sortMode === "type" ? "Sorted by type — click for default" : "Sort by type"}
          >
            ↑T
          </button>
          {onSetWipLimit && (
            <button
              onClick={startEditWipLimit}
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-white/60 dark:hover:bg-gray-800/60 rounded-md w-6 h-6 flex items-center justify-center text-xs leading-none transition-colors"
              title={wipLimit != null ? `WIP limit: ${wipLimit} — click to edit` : "Set WIP limit"}
            >
              ⚙
            </button>
          )}
          {!isCreating && column.name === "Todo" && (
            <button
              onClick={() => onCreateClick(column.id)}
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-white/60 dark:hover:bg-gray-800/60 rounded-md w-6 h-6 flex items-center justify-center text-lg leading-none transition-colors"
              title="Add issue"
            >
              +
            </button>
          )}
        </div>
      </div>

      <div className={`relative rounded-lg ${stacked ? "" : "flex-1 min-h-0 overflow-hidden"}`}>
        {!stacked && (scrollState === "top" || scrollState === "middle") && (
          <div className="absolute top-0 left-0 right-0 h-6 bg-gradient-to-b from-surface-sunken dark:from-surface-sunken-dark to-transparent z-10 pointer-events-none rounded-t-lg" />
        )}
        <div
          ref={scrollRef}
          onScroll={stacked ? undefined : updateScrollState}
          className={`${cardDensity === "compact" ? "space-y-1" : "space-y-1.5"} column-scroll-container ${stacked ? "" : "h-full overflow-y-auto pb-6"}`}
        >
          {swimlaneDimension === "none" && (
            <>
              {displayedIssues.map((issue: IssueWithStatus, idx: number) => (
                <div key={issue.id}>
                  <DropGap
                    visible={dragOver}
                    onDrop={(e) => handleDropGap(e, computeGapSortOrder(idx))}
                  />
                  <IssueCard
                    issue={issue}
                    onClick={onIssueClick}
                    onWorkspaceClick={onWorkspaceClick}
                    onStartWorkspace={onStartWorkspace}
                    onDryRun={onDryRun}
                    onDragStart={onDragStart}
                    onDuplicate={onDuplicate}
                    onMoveToNext={nextStatus && onMoveToNext ? (iss) => onMoveToNext(iss, nextStatus.id) : undefined}
                    nextStatusName={nextStatus?.name}
                    tags={issue.tags}
                    allProjectTags={allProjectTags}
                    quickUpdate={quickUpdate}
                    allStatuses={allColumns?.map((c) => ({ id: c.id, name: c.name }))}
                    onDeleteIssue={onDeleteIssue}
                    searchQuery={searchQuery}
                    liveActivity={sessionActivity?.[issue.id]}
                    liveStats={liveStats?.[issue.id]}
                    todos={sessionTodos?.[issue.id]}
                    isPendingIssue={pendingIssueIds?.has(issue.id)}
                    isPendingWorkspace={pendingWorkspaceIssueIds?.has(issue.id)}
                    isSelected={selectedIssueIds?.has(issue.id)}
                    isKeyboardFocused={keyboardCursorIssueId === issue.id}
                    cardDensity={cardDensity}
                    showAgingHeatmap={showAgingHeatmap}
                    agingWarmDays={agingWarmDays}
                    agingHotDays={agingHotDays}
                  />
                </div>
              ))}
              {dragOver && displayedIssues.length > 0 && (
                <DropGap
                  visible={true}
                  onDrop={(e) => handleDropGap(e, computeGapSortOrder(displayedIssues.length))}
                />
              )}
            </>
          )}
          {swimlaneDimension === "priority" && (() => {
            const groups = groupByPriority(displayedIssues);
            if (groups.length === 0) return null;
            return groups.map((group) => {
              const style = PRIORITY_LANE_STYLES[group.key] ?? PRIORITY_LANE_STYLES.ungrouped;
              return (
                <SwimLaneGroup
                  key={group.key}
                  laneKey={group.key}
                  label={style.label}
                  dot={style.dot}
                  headerBg={style.headerBg}
                  headerBorder={style.headerBorder}
                  headerText={style.headerText}
                  count={group.issues.length}
                  columnId={column.id}
                  onDropWithLane={onDropWithLane}
                >
                  {group.issues.map((issue, idx) => (
                    <div key={issue.id}>
                      <IssueCard
                        issue={issue}
                        onClick={onIssueClick}
                        onWorkspaceClick={onWorkspaceClick}
                        onStartWorkspace={onStartWorkspace}
                        onDryRun={onDryRun}
                        onDragStart={onDragStart}
                        onDuplicate={onDuplicate}
                        onMoveToNext={nextStatus && onMoveToNext ? (iss) => onMoveToNext(iss, nextStatus.id) : undefined}
                        nextStatusName={nextStatus?.name}
                        tags={issue.tags}
                        allProjectTags={allProjectTags}
                        quickUpdate={quickUpdate}
                        allStatuses={allColumns?.map((c) => ({ id: c.id, name: c.name }))}
                        onDeleteIssue={onDeleteIssue}
                        searchQuery={searchQuery}
                        liveActivity={sessionActivity?.[issue.id]}
                        liveStats={liveStats?.[issue.id]}
                        todos={sessionTodos?.[issue.id]}
                        isPendingIssue={pendingIssueIds?.has(issue.id)}
                        isPendingWorkspace={pendingWorkspaceIssueIds?.has(issue.id)}
                        isSelected={selectedIssueIds?.has(issue.id)}
                        isKeyboardFocused={keyboardCursorIssueId === issue.id}
                        cardDensity={cardDensity}
                      />
                      {idx < group.issues.length - 1 && <div className={`${cardDensity === "compact" ? "mt-1" : "mt-1.5"}`} />}
                    </div>
                  ))}
                </SwimLaneGroup>
              );
            });
          })()}
          {swimlaneDimension === "tag" && (() => {
            const groups = groupByTag(displayedIssues);
            if (groups.length === 0) return null;
            return groups.map((group) => (
              <SwimLaneGroup
                key={group.key}
                laneKey={group.key}
                label={group.label}
                dot={undefined}
                dotColor={group.color ?? undefined}
                headerBg="bg-gray-50 dark:bg-gray-800/40"
                headerBorder="border-gray-200 dark:border-gray-700"
                headerText="text-gray-700 dark:text-gray-300"
                count={group.issues.length}
                columnId={column.id}
                onDropWithLane={onDropWithLane}
                dragOver={dragOver}
              >
                {group.issues.map((issue, idx) => (
                  <div key={issue.id}>
                    <IssueCard
                      issue={issue}
                      onClick={onIssueClick}
                      onWorkspaceClick={onWorkspaceClick}
                      onStartWorkspace={onStartWorkspace}
                      onDryRun={onDryRun}
                      onDragStart={onDragStart}
                      onDuplicate={onDuplicate}
                      onMoveToNext={nextStatus && onMoveToNext ? (iss) => onMoveToNext(iss, nextStatus.id) : undefined}
                      nextStatusName={nextStatus?.name}
                      tags={issue.tags}
                      allProjectTags={allProjectTags}
                      quickUpdate={quickUpdate}
                      allStatuses={allColumns?.map((c) => ({ id: c.id, name: c.name }))}
                      onDeleteIssue={onDeleteIssue}
                      searchQuery={searchQuery}
                      liveActivity={sessionActivity?.[issue.id]}
                      liveStats={liveStats?.[issue.id]}
                      todos={sessionTodos?.[issue.id]}
                      isPendingIssue={pendingIssueIds?.has(issue.id)}
                      isPendingWorkspace={pendingWorkspaceIssueIds?.has(issue.id)}
                      isSelected={selectedIssueIds?.has(issue.id)}
                      isKeyboardFocused={keyboardCursorIssueId === issue.id}
                      cardDensity={cardDensity}
                    />
                    {idx < group.issues.length - 1 && <div className={`${cardDensity === "compact" ? "mt-1" : "mt-1.5"}`} />}
                  </div>
                ))}
              </SwimLaneGroup>
            ));
          })()}
          {isCreating && children}
          {column.issues.length === 0 && !isCreating && !dragOver && (
            <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-4">No issues</p>
          )}
        </div>
        {!stacked && (scrollState === "bottom" || scrollState === "middle") && (
          <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-surface-sunken dark:from-surface-sunken-dark to-transparent z-10 pointer-events-none rounded-b-lg" />
        )}
      </div>
    </div>
    {onResizeStart && (
      <div
        className="hidden sm:flex w-2 shrink-0 cursor-col-resize items-center justify-center group self-stretch"
        onMouseDown={onResizeStart}
        onDoubleClick={onResizeReset}
        title="Drag to resize · Double-click to reset"
      >
        <div className="w-0.5 h-8 rounded-full bg-gray-300 dark:bg-gray-600 group-hover:bg-brand-400 transition-colors" />
      </div>
    )}
    </div>
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

function DropGap({
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
