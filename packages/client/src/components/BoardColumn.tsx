import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import type { LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";
import { type ProjectTag, type QuickUpdateCallbacks } from "./IssueCard.js";
import { BoardColumnCard } from "./BoardColumnCard.js";
import { evaluateWipLimit } from "../lib/wipLimits.js";
import { computeDropSortOrder } from "../lib/reorderIssues.js";
import { computeColumnScrollState } from "../lib/columnScrollState.js";
import { computeColumnEstimate } from "../lib/columnHelpers.js";
import { SwimlaneRenderer, DropGap } from "./BoardColumnSwimlanes.js";
import {
  loadSortMode,
  saveSortMode,
  nextSortMode,
  sortColumnIssues,
  type SortMode,
} from "../lib/boardColumnSort.js";
import type { CardDensity } from "../hooks/useBoardPreferences.js";
import { useBoardCursorStore } from "../stores/boardCursorStore.js";
import "./BoardColumn.css";

export type SwimlaneDimension = "none" | "priority" | "tag";

interface BoardColumnProps {
  column: StatusWithIssues;
  allColumns?: StatusWithIssues[];
  projectId: string;
  creatingInColumn: string | null;
  onCreateClick: (statusId: string) => void;
  onCreateCancel: () => void;
  onIssueClick: (issue: IssueWithStatus, event: React.MouseEvent) => void;
  onWorkspaceClick?: (issue: IssueWithStatus, workspaceId?: string) => void;
  onOpenDiff?: (issue: IssueWithStatus, workspaceId: string) => void;
  onStartWorkspace?: (issue: IssueWithStatus) => void;
  onDryRun?: (issue: IssueWithStatus) => void;
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  onDrop: (statusId: string, sortOrder?: number) => void;
  onDuplicate?: (issue: IssueWithStatus) => void;
  onMoveToNext?: (issue: IssueWithStatus, nextStatusId: string) => void;
  onDeleteIssue?: (issueId: string) => void;
  sessionActivity?: Record<string, string>;
  liveStats?: Record<string, LiveSessionStats>;
  sessionTodos?: Record<string, TodoItem[]>;
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
const VIRTUALIZE_ISSUE_THRESHOLD = 15;
const ESTIMATED_CARD_HEIGHT = 145;
const CARD_GAP_PX = {
  compact: 4,
  comfortable: 6,
} satisfies Record<CardDensity, number>;

export function BoardColumn({
  column,
  allColumns,
  projectId: _projectId,
  creatingInColumn,
  onCreateClick,
  onCreateCancel: _onCreateCancel,
  onIssueClick,
  onWorkspaceClick,
  onOpenDiff,
  onStartWorkspace,
  onDryRun,
  onDragStart,
  onDrop,
  onDuplicate,
  onMoveToNext,
  onDeleteIssue,
  sessionActivity,
  liveStats,
  sessionTodos,
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
  // Cursor slice (#958): subscribed here only for the virtualizer
  // scroll-follow effect; the per-card highlight lives in BoardColumnCard.
  const keyboardCursorIssueId = useBoardCursorStore((s) => s.keyboardCursorIssueId);
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

  // Hoisted once per column (instead of rebuilt inline for every card) so the prop
  // identity is stable across renders — required for the IssueCard memo to skip
  // re-rendering on live-session ticks. Only consumed by the card's on-demand
  // "move to status" submenu.
  const statusOptions = useMemo(
    () => allColumns?.map((c) => ({ id: c.id, name: c.name })),
    [allColumns],
  );

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    setScrollState(computeColumnScrollState({ scrollTop, scrollHeight, clientHeight }));
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
    const next: SortMode = nextSortMode(sortMode);
    setSortMode(next);
    saveSortMode(column.id, next);
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
  const displayedIssues = sortColumnIssues(column.issues, sortMode);
  const wipStatus = evaluateWipLimit(column.issues.length, wipLimit ?? null);
  const estimateRollup = computeColumnEstimate(column.issues);
  const shouldVirtualizeIssues =
    !stacked && swimlaneDimension === "none" && displayedIssues.length > VIRTUALIZE_ISSUE_THRESHOLD;
  const cardGapPx = CARD_GAP_PX[cardDensity];

  const issueVirtualizer = useVirtualizer({
    count: displayedIssues.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: useCallback(() => ESTIMATED_CARD_HEIGHT, []),
    overscan: 5,
  });

  const virtualIssueItems = shouldVirtualizeIssues ? issueVirtualizer.getVirtualItems() : [];
  const virtualIssuesHeight = shouldVirtualizeIssues ? issueVirtualizer.getTotalSize() : 0;

  useEffect(() => {
    if (!shouldVirtualizeIssues || !keyboardCursorIssueId) return;
    const issueIndex = displayedIssues.findIndex((issue) => issue.id === keyboardCursorIssueId);
    if (issueIndex === -1) return;
    issueVirtualizer.scrollToIndex(issueIndex, { align: "auto" });
  }, [displayedIssues, issueVirtualizer, keyboardCursorIssueId, shouldVirtualizeIssues]);

  // Single source of truth for the IssueCard prop binding shared by the flat list
  // and both swimlane modes. The aging-heatmap props are only forwarded in the flat
  // list (matching the original per-branch prop lists), so IssueCard's defaults
  // still apply inside swimlanes.
  const renderCard = (issue: IssueWithStatus, includeAging: boolean) => (
    <BoardColumnCard
      issue={issue}
      includeAging={includeAging}
      onIssueClick={onIssueClick}
      onWorkspaceClick={onWorkspaceClick}
      onOpenDiff={onOpenDiff}
      onStartWorkspace={onStartWorkspace}
      onDryRun={onDryRun}
      onDragStart={onDragStart}
      onDuplicate={onDuplicate}
      onMoveToNext={onMoveToNext}
      nextStatus={nextStatus}
      allProjectTags={allProjectTags}
      quickUpdate={quickUpdate}
      statusOptions={statusOptions}
      onDeleteIssue={onDeleteIssue}
      sessionActivity={sessionActivity}
      liveStats={liveStats}
      sessionTodos={sessionTodos}
      cardDensity={cardDensity}
      showAgingHeatmap={showAgingHeatmap}
      agingWarmDays={agingWarmDays}
      agingHotDays={agingHotDays}
    />
  );

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
      onDragLeave={() => { handleDragLeave(); onColumnDragLeave?.(); }}
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
                {wipLimit != null
                  ? `${column.issues.length} / ${wipLimit}`
                  : column.count > column.issues.length
                    ? `${column.issues.length} of ${column.count}`
                    : column.count}
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
          className={`${shouldVirtualizeIssues ? "" : cardDensity === "compact" ? "space-y-1" : "space-y-1.5"} column-scroll-container ${stacked ? "" : "h-full overflow-y-auto pb-6"}`}
        >
          {swimlaneDimension === "none" && (
            <>
              {shouldVirtualizeIssues ? (
                <div style={{ height: virtualIssuesHeight, position: "relative" }}>
                  {virtualIssueItems.map((virtualIssue) => {
                    const issue = displayedIssues[virtualIssue.index];
                    if (!issue) return null;
                    return (
                      <div
                        key={issue.id}
                        data-index={virtualIssue.index}
                        ref={issueVirtualizer.measureElement}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          right: 0,
                          transform: `translateY(${virtualIssue.start}px)`,
                          paddingBottom: cardGapPx,
                        }}
                      >
                        <DropGap
                          visible={dragOver}
                          onDrop={(e) => handleDropGap(e, computeGapSortOrder(virtualIssue.index))}
                        />
                        {renderCard(issue, true)}
                      </div>
                    );
                  })}
                </div>
              ) : (
                displayedIssues.map((issue: IssueWithStatus, idx: number) => (
                  <div key={issue.id}>
                    <DropGap
                      visible={dragOver}
                      onDrop={(e) => handleDropGap(e, computeGapSortOrder(idx))}
                    />
                    {renderCard(issue, true)}
                  </div>
                ))
              )}
              {dragOver && displayedIssues.length > 0 && (
                <DropGap
                  visible={true}
                  onDrop={(e) => handleDropGap(e, computeGapSortOrder(displayedIssues.length))}
                />
              )}
            </>
          )}
          {swimlaneDimension !== "none" && (
            <SwimlaneRenderer
              dimension={swimlaneDimension}
              issues={displayedIssues}
              columnId={column.id}
              onDropWithLane={onDropWithLane}
              cardDensity={cardDensity}
              renderIssueCard={(issue) => renderCard(issue, false)}
            />
          )}
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
