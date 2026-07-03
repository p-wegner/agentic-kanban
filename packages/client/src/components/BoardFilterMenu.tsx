import { useEffect, useRef, useState } from "react";
import type { MilestoneResponse } from "@agentic-kanban/shared";
import { PRIORITY_META } from "../lib/chartColors.js";
import { useBoardFilterStore } from "../stores/boardFilterStore.js";

interface BoardFilterMenuProps {
  statuses: { id: string; name: string }[];
  milestones: MilestoneResponse[];
  tags: { id: string; name: string; color?: string | null }[];
}

/**
 * Single entry point for board filtering. Status, issue type, milestone, tags,
 * and the Blocked / Stale quick filters used to be separate clusters spread
 * across BoardStats, SavedBoardViews, and BoardToolbar (the tag legend ate its
 * own full row). Collapsing them here keeps the header to one row and makes the
 * active-filter count obvious at a glance.
 *
 * Filter slice (#958): all filter state/actions come straight from the board
 * filter store; only the option data (statuses, milestones, tags) is passed in.
 */
export function BoardFilterMenu({
  statuses,
  milestones,
  tags,
}: BoardFilterMenuProps) {
  const statusFilterId = useBoardFilterStore((s) => s.statusFilterId);
  const onStatusFilterChange = useBoardFilterStore((s) => s.setStatusFilterId);
  const issueTypeFilter = useBoardFilterStore((s) => s.issueTypeFilter);
  const onIssueTypeFilterChange = useBoardFilterStore((s) => s.setIssueTypeFilter);
  const priorityFilter = useBoardFilterStore((s) => s.priorityFilter);
  const onPriorityFilterChange = useBoardFilterStore((s) => s.setPriorityFilter);
  const milestoneFilterId = useBoardFilterStore((s) => s.milestoneFilterId);
  const onMilestoneFilterChange = useBoardFilterStore((s) => s.setMilestoneFilterId);
  const showBlocked = useBoardFilterStore((s) => s.showBlocked);
  const onToggleBlocked = useBoardFilterStore((s) => s.toggleShowBlocked);
  const showStaleOnly = useBoardFilterStore((s) => s.showStaleOnly);
  const onToggleStaleOnly = useBoardFilterStore((s) => s.toggleShowStaleOnly);
  const activeTagIds = useBoardFilterStore((s) => s.activeTagIds);
  const onTagFilterToggle = useBoardFilterStore((s) => s.toggleTagFilter);
  const onClearTagFilter = useBoardFilterStore((s) => s.clearTagFilter);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const activeCount =
    (statusFilterId ? 1 : 0) +
    (issueTypeFilter ? 1 : 0) +
    (priorityFilter ? 1 : 0) +
    (milestoneFilterId ? 1 : 0) +
    (showBlocked ? 1 : 0) +
    (showStaleOnly ? 1 : 0) +
    activeTagIds.size;

  function clearAll() {
    if (statusFilterId) onStatusFilterChange(null);
    if (issueTypeFilter) onIssueTypeFilterChange(null);
    if (priorityFilter) onPriorityFilterChange(null);
    if (milestoneFilterId) onMilestoneFilterChange(null);
    if (showBlocked) onToggleBlocked();
    if (showStaleOnly) onToggleStaleOnly();
    if (activeTagIds.size > 0) onClearTagFilter();
  }

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Filter issues by status, type, milestone, blocked or stale"
        className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${
          activeCount > 0
            ? "bg-brand-600 text-white border-brand-600 hover:bg-brand-700"
            : "bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
        }`}
      >
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 4.5h18l-7 8v6l-4 2v-8z" />
        </svg>
        <span className="hidden sm:inline">Filter</span>
        {activeCount > 0 && (
          <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-white/25 px-1 text-[10px] font-semibold leading-none">
            {activeCount}
          </span>
        )}
        <svg className={`w-2.5 h-2.5 transition-transform ${open ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full z-30 mt-1 w-64 rounded-md border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-900 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint dark:text-gray-500">Status</label>
            <select
              value={statusFilterId ?? ""}
              onChange={(e) => onStatusFilterChange(e.target.value || null)}
              className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {statuses.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint dark:text-gray-500">Type</label>
            <div className="flex items-center gap-0 border border-black/[0.07] dark:border-white/10 rounded-md p-0.5 bg-surface-raised dark:bg-surface-raised-dark">
              {(["All", "feature", "bug", "chore"] as const).map((type) => {
                const label = type === "All" ? "All" : type === "chore" ? "Quality" : type.charAt(0).toUpperCase() + type.slice(1);
                const isActive = type === "All" ? issueTypeFilter === null : issueTypeFilter === type;
                return (
                  <button
                    key={type}
                    onClick={() => onIssueTypeFilterChange(type === "All" ? null : type)}
                    className={`flex-1 px-2 py-0.5 text-xs rounded transition-colors ${
                      isActive ? "bg-brand-600 text-white" : "text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-700"
                    }`}
                    aria-pressed={isActive}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint dark:text-gray-500">Priority</label>
            <select
              value={priorityFilter ?? ""}
              onChange={(e) => onPriorityFilterChange(e.target.value || null)}
              className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
              aria-label="Filter by priority"
            >
              <option value="">All priorities</option>
              {PRIORITY_META.map((priority) => (
                <option key={priority.key} value={priority.key}>{priority.label}</option>
              ))}
            </select>
          </div>

          {milestones.length > 0 && (
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint dark:text-gray-500">Milestone</label>
              <select
                value={milestoneFilterId ?? ""}
                onChange={(e) => onMilestoneFilterChange(e.target.value || null)}
                className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
                aria-label="Filter by milestone"
              >
                <option value="">All milestones</option>
                {milestones.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          )}

          {tags.length > 0 && (
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint dark:text-gray-500">Tags</label>
              <div className="flex items-center gap-1 flex-wrap">
                {tags.map((tag) => {
                  const isActive = activeTagIds.has(tag.id);
                  return (
                    <button
                      key={tag.id}
                      onClick={() => onTagFilterToggle(tag.id)}
                      aria-pressed={isActive}
                      title={`Filter by tag: ${tag.name}`}
                      className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border transition-colors ${
                        isActive
                          ? "border-brand-600 bg-brand-600 text-white hover:bg-brand-700"
                          : "border-black/[0.07] dark:border-white/10 bg-surface-raised dark:bg-surface-raised-dark text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-700"
                      }`}
                    >
                      {tag.color && (
                        <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                      )}
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-0.5 border-t border-gray-100 dark:border-gray-800 pt-2">
            <label className="flex items-center gap-2 rounded px-1 py-1 text-xs cursor-pointer hover:bg-surface-sunken dark:hover:bg-gray-800" title="Show only blocked issues">
              <input type="checkbox" checked={showBlocked} onChange={onToggleBlocked} className="h-3 w-3 rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
              <span className="flex-1 text-ink dark:text-gray-200">Blocked only</span>
            </label>
            <label className="flex items-center gap-2 rounded px-1 py-1 text-xs cursor-pointer hover:bg-surface-sunken dark:hover:bg-gray-800" title="Show only stale backlog issues">
              <input type="checkbox" checked={showStaleOnly} onChange={onToggleStaleOnly} className="h-3 w-3 rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
              <span className="flex-1 text-ink dark:text-gray-200">Stale only</span>
            </label>
          </div>

          {activeCount > 0 && (
            <button
              onClick={clearAll}
              className="self-start rounded border border-black/[0.07] dark:border-white/10 px-2 py-1 text-[11px] font-medium text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800 transition-colors"
            >
              Clear all filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
