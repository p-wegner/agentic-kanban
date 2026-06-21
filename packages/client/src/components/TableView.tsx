import React, { useEffect, useState } from "react";
import type { IssueWithStatus, StatusWithIssues, UpdateIssueRequest } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { formatDateKeyLong } from "../lib/dateKey.js";
import { showToast } from "./Toast.js";
import { CollapsibleSection } from "./CollapsibleSection.js";
import { filterIssues } from "../lib/tableView-filters.js";
import { applySortDirection, compareSortKey } from "../lib/tableView-sorting.js";
import type { SortDir, SortKey } from "../lib/tableView-sorting.js";
import { bulkAddTag, bulkDeleteIssues, bulkMoveStatus, bulkRemoveTag, bulkUpdateIssues } from "../lib/tableView-bulk-ops.js";
import type { BulkOpDeps } from "../lib/tableView-bulk-ops.js";
import { useBulkOperations } from "../hooks/useBulkOperations.js";
import type { Tag } from "../hooks/useBulkOperations.js";
import { resolveRowCells, PRIORITY_LABEL, tagClass } from "../lib/tableView-cells.js";

interface TableViewProps {
  columns: StatusWithIssues[];
  onIssueClick: (issue: IssueWithStatus) => void;
  searchQuery?: string;
  onRefresh?: () => void;
  createdDateFilter?: string | null;
  onClearCreatedDateFilter?: () => void;
}

const ESTIMATE_OPTIONS = ["XS", "S", "M", "L", "XL"] as const;
const PRIORITY_OPTIONS = ["critical", "high", "medium", "low"] as const;

type TableSort = { key: SortKey; dir: SortDir };

const SORTABLE_COLUMNS: [SortKey, string][] = [
  ["number", "#"],
  ["title", "Title"],
  ["status", "Status"],
  ["priority", "Priority"],
  ["type", "Type"],
  ["estimate", "Estimate"],
  ["updated", "Updated"],
  ["dueDate", "Due Date"],
];

function SortIcon({ col, sort }: { col: SortKey; sort: TableSort }) {
  if (sort.key !== col) return <span className="text-gray-300 dark:text-gray-600 ml-1">↕</span>;
  return <span className="text-brand-500 ml-1">{sort.dir === "asc" ? "↑" : "↓"}</span>;
}

interface TableHeaderProps {
  sort: TableSort;
  onSortChange: (key: SortKey) => void;
  allChecked: boolean;
  someChecked: boolean;
  onToggleSelectAll: () => void;
}

function TableHeader({ sort, onSortChange, allChecked, someChecked, onToggleSelectAll }: TableHeaderProps) {
  return (
    <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800 z-10">
      <tr>
        <th className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 w-8">
          <input
            type="checkbox"
            checked={allChecked}
            ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked; }}
            onChange={onToggleSelectAll}
            className="rounded border-gray-300 dark:border-gray-600 text-brand-500 cursor-pointer"
            aria-label="Select all"
          />
        </th>
        {SORTABLE_COLUMNS.map(([key, label]) => (
          <th
            key={key}
            onClick={() => onSortChange(key)}
            className="text-left text-xs font-medium text-gray-500 dark:text-gray-400 px-3 py-2 border-b border-gray-200 dark:border-gray-700 cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-200 whitespace-nowrap"
          >
            {label}<SortIcon col={key} sort={sort} />
          </th>
        ))}
        <th className="text-left text-xs font-medium text-gray-500 dark:text-gray-400 px-3 py-2 border-b border-gray-200 dark:border-gray-700 whitespace-nowrap">
          Tags
        </th>
      </tr>
    </thead>
  );
}

interface TableRowProps {
  issue: IssueWithStatus;
  selected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onClick: () => void;
}

function TableRow({ issue, selected, onSelect, onClick }: TableRowProps) {
  const cells = resolveRowCells(issue);
  return (
    <tr
      onClick={onClick}
      className={`border-b border-gray-100 dark:border-gray-800 hover:bg-brand-50 dark:hover:bg-brand-900/20 cursor-pointer transition-colors ${selected ? "bg-brand-50/60 dark:bg-brand-900/10" : ""}`}
    >
      <td className="px-3 py-1.5" onClick={onSelect}>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => {}}
          className="rounded border-gray-300 dark:border-gray-600 text-brand-500 cursor-pointer"
          aria-label={`Select issue ${issue.issueNumber}`}
        />
      </td>
      <td className="px-3 py-1.5 text-gray-400 dark:text-gray-500 text-xs whitespace-nowrap">
        #{issue.issueNumber ?? "—"}
      </td>
      <td className="px-3 py-1.5 max-w-xs">
        <span className="font-medium text-gray-900 dark:text-gray-100 truncate block">{issue.title}</span>
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap">
        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${cells.statusClass}`}>
          {issue.statusName}
        </span>
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap">
        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${cells.priorityClass}`}>
          {cells.priorityLabel}
        </span>
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap">
        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${cells.typeClass}`}>
          {cells.typeLabel}
        </span>
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap text-xs text-gray-600 dark:text-gray-400">
        {issue.estimate ?? <span className="text-gray-300 dark:text-gray-600">—</span>}
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">
        {cells.updatedText}
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap text-xs">
        {cells.due ? (
          <span className={cells.due.overdue ? "text-red-600 font-medium" : "text-gray-500 dark:text-gray-400"}>
            {cells.due.text}
          </span>
        ) : <span className="text-gray-300 dark:text-gray-600">—</span>}
      </td>
      <td className="px-3 py-1.5">
        <div className="flex flex-wrap gap-1">
          {cells.tags.map((tag) => (
            <span key={tag.id} className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${tag.className}`}>
              {tag.name}
            </span>
          ))}
        </div>
      </td>
    </tr>
  );
}

export function TableView({
  columns,
  onIssueClick,
  searchQuery,
  onRefresh,
  createdDateFilter,
  onClearCreatedDateFilter,
}: TableViewProps) {
  const [sort, setSort] = useState<TableSort>({ key: "number", dir: "asc" });
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const {
    selectedIds, setSelectedIds,
    bulkLoading, setBulkLoading,
    bulkStatusOpen, setBulkStatusOpen,
    bulkPriorityOpen, setBulkPriorityOpen,
    bulkEstimateOpen, setBulkEstimateOpen,
    bulkDueDateOpen, setBulkDueDateOpen,
    bulkTagOpen, setBulkTagOpen,
    bulkRemoveTagOpen, setBulkRemoveTagOpen,
    bulkDueDate, setBulkDueDate,
    allTags, setAllTags,
    tagsLoaded, setTagsLoaded,
    statusDropdownRef,
    priorityDropdownRef,
    estimateDropdownRef,
    dueDateDropdownRef,
    tagDropdownRef,
    removeTagDropdownRef,
  } = useBulkOperations();

  const allIssues = columns.flatMap((col) =>
    col.issues.map((issue) => ({ ...issue, statusName: col.name }))
  );
  const createdDateLabel = createdDateFilter ? formatDateKeyLong(createdDateFilter) : null;

  useEffect(() => {
    if (createdDateFilter) setStatusFilter("all");
  }, [createdDateFilter]);

  const filtered = filterIssues(allIssues, { statusFilter, searchQuery, createdDateFilter });

  const sorted = [...filtered].sort((a, b) => applySortDirection(compareSortKey(a, b, sort.key), sort.dir));

  function toggleSort(key: SortKey) {
    setSort((prev) => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }

  const statusNames = [...new Set(columns.map((c) => c.name))];

  const visibleIds = sorted.map((i) => i.id);
  const allChecked = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someChecked = visibleIds.some((id) => selectedIds.has(id));
  // Only operate on items that are both selected AND currently visible (respects active filter)
  const activeSelectedIds = visibleIds.filter((id) => selectedIds.has(id));

  function toggleSelectAll() {
    if (allChecked) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(visibleIds));
    }
  }

  function toggleSelectOne(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function loadTags() {
    if (tagsLoaded) return;
    try {
      const tags = await apiFetch<Tag[]>("/api/tags");
      setAllTags(tags);
      setTagsLoaded(true);
    } catch {
      showToast("Failed to load tags", "error");
    }
  }

  const bulkOpDeps = (): BulkOpDeps => ({
    ids: [...activeSelectedIds],
    api: apiFetch,
    toast: showToast,
    setSelectedIds,
    setBulkLoading,
    onRefresh,
  });

  async function handleBulkMoveStatus(statusId: string, statusName: string) {
    setBulkStatusOpen(false);
    await bulkMoveStatus(statusId, statusName, bulkOpDeps());
  }

  async function handleBulkUpdate(data: UpdateIssueRequest, successLabel: string) {
    setBulkPriorityOpen(false);
    setBulkEstimateOpen(false);
    setBulkDueDateOpen(false);
    await bulkUpdateIssues(data, successLabel, bulkOpDeps());
  }

  async function handleBulkAddTag(tag: Tag) {
    setBulkTagOpen(false);
    await bulkAddTag(tag, bulkOpDeps());
  }

  async function handleBulkRemoveTag(tag: Tag) {
    setBulkRemoveTagOpen(false);
    await bulkRemoveTag(tag, bulkOpDeps());
  }

  async function handleBulkDelete() {
    if (!confirm(`Delete ${activeSelectedIds.length} issue${activeSelectedIds.length !== 1 ? "s" : ""}? This cannot be undone.`)) return;
    await bulkDeleteIssues(bulkOpDeps());
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 px-4 pb-4">
      <div className="flex items-center gap-3 py-2 mb-2 flex-wrap">
        <span className="text-xs text-gray-500 dark:text-gray-400">{sorted.length} issue{sorted.length !== 1 ? "s" : ""}</span>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300"
          aria-label="Table status filter"
        >
          <option value="active">Active only</option>
          <option value="all">All statuses</option>
          {statusNames.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {createdDateFilter && createdDateLabel && (
          <div className="inline-flex items-center gap-2 rounded-md border border-brand-200 dark:border-brand-700 bg-brand-50 dark:bg-brand-900/30 px-2 py-1 text-xs text-brand-700 dark:text-brand-200">
            <span>Created {createdDateLabel}</span>
            <button
              type="button"
              onClick={onClearCreatedDateFilter}
              className="rounded px-1 text-brand-500 hover:bg-brand-100 hover:text-brand-800 dark:text-brand-300 dark:hover:bg-brand-900 dark:hover:text-brand-100"
              aria-label="Clear created date filter"
              title="Clear created date filter"
            >
              x
            </button>
          </div>
        )}
      </div>

      {/* Bulk action bar */}
      {someChecked && (
        <CollapsibleSection
          tone="brand"
          defaultOpen
          className="mb-2"
          bodyClassName="border-t border-brand-200 px-3 py-2 dark:border-brand-800"
          title={<span className="normal-case text-brand-700 dark:text-brand-300">Selection</span>}
          badge={
            <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-semibold leading-none text-white">
              {activeSelectedIds.length}
            </span>
          }
          summary="selected"
          actions={
            <button
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-brand-500 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-200 underline"
            >
              Clear
            </button>
          }
        >
          <div className="flex flex-wrap items-center gap-2">

          {/* Move to status */}
          <div className="relative" ref={statusDropdownRef}>
            <button
              disabled={bulkLoading}
              onClick={() => {
                setBulkStatusOpen((v) => !v);
                setBulkPriorityOpen(false);
                setBulkEstimateOpen(false);
                setBulkDueDateOpen(false);
                setBulkTagOpen(false);
                setBulkRemoveTagOpen(false);
              }}
              className="flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              Move to status ▾
            </button>
            {bulkStatusOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 min-w-[160px] rounded-lg border border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark shadow-lg py-1">
                {columns.map((col) => (
                  <button
                    key={col.id}
                    onClick={() => handleBulkMoveStatus(col.id, col.name)}
                    className="w-full text-left px-3 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-brand-50 dark:hover:bg-brand-900/30"
                  >
                    {col.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Set priority */}
          <div className="relative" ref={priorityDropdownRef}>
            <button
              disabled={bulkLoading}
              onClick={() => {
                setBulkPriorityOpen((v) => !v);
                setBulkStatusOpen(false);
                setBulkEstimateOpen(false);
                setBulkDueDateOpen(false);
                setBulkTagOpen(false);
                setBulkRemoveTagOpen(false);
              }}
              className="flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              Set priority ▾
            </button>
            {bulkPriorityOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 min-w-[150px] rounded-lg border border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark shadow-lg py-1">
                {PRIORITY_OPTIONS.map((priority) => (
                  <button
                    key={priority}
                    onClick={() => handleBulkUpdate({ priority }, `Set priority to "${PRIORITY_LABEL[priority]}"`)}
                    className="w-full text-left px-3 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-brand-50 dark:hover:bg-brand-900/30"
                  >
                    {PRIORITY_LABEL[priority]}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Set estimate */}
          <div className="relative" ref={estimateDropdownRef}>
            <button
              disabled={bulkLoading}
              onClick={() => {
                setBulkEstimateOpen((v) => !v);
                setBulkStatusOpen(false);
                setBulkPriorityOpen(false);
                setBulkDueDateOpen(false);
                setBulkTagOpen(false);
                setBulkRemoveTagOpen(false);
              }}
              className="flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              Set estimate ▾
            </button>
            {bulkEstimateOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-lg border border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark shadow-lg py-1">
                {ESTIMATE_OPTIONS.map((estimate) => (
                  <button
                    key={estimate}
                    onClick={() => handleBulkUpdate({ estimate }, `Set estimate to "${estimate}"`)}
                    className="w-full text-left px-3 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-brand-50 dark:hover:bg-brand-900/30"
                  >
                    {estimate}
                  </button>
                ))}
                <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
                <button
                  onClick={() => handleBulkUpdate({ estimate: null }, "Cleared estimate")}
                  className="w-full text-left px-3 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:bg-brand-50 dark:hover:bg-brand-900/30"
                >
                  Clear estimate
                </button>
              </div>
            )}
          </div>

          {/* Set due date */}
          <div className="relative" ref={dueDateDropdownRef}>
            <button
              disabled={bulkLoading}
              onClick={() => {
                setBulkDueDateOpen((v) => !v);
                setBulkStatusOpen(false);
                setBulkPriorityOpen(false);
                setBulkEstimateOpen(false);
                setBulkTagOpen(false);
                setBulkRemoveTagOpen(false);
              }}
              className="flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              Set due date ▾
            </button>
            {bulkDueDateOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-lg border border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark shadow-lg p-2">
                <input
                  type="date"
                  value={bulkDueDate}
                  onChange={(e) => setBulkDueDate(e.target.value)}
                  className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200"
                  aria-label="Bulk due date"
                />
                <div className="mt-2 flex items-center justify-end gap-2">
                  <button
                    onClick={() => handleBulkUpdate({ dueDate: null }, "Cleared due date")}
                    className="text-xs px-2 py-1 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    Clear
                  </button>
                  <button
                    disabled={!bulkDueDate}
                    onClick={() => handleBulkUpdate({ dueDate: bulkDueDate }, `Set due date to ${bulkDueDate}`)}
                    className="text-xs px-2 py-1 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
                  >
                    Apply
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Add tag */}
          <div className="relative" ref={tagDropdownRef}>
            <button
              disabled={bulkLoading}
              onClick={() => {
                setBulkTagOpen((v) => !v);
                setBulkStatusOpen(false);
                setBulkPriorityOpen(false);
                setBulkEstimateOpen(false);
                setBulkDueDateOpen(false);
                setBulkRemoveTagOpen(false);
                void loadTags();
              }}
              className="flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              Add tag ▾
            </button>
            {bulkTagOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 min-w-[160px] rounded-lg border border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark shadow-lg py-1">
                {allTags.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500">No tags available</div>
                ) : allTags.map((tag) => (
                  <button
                    key={tag.id}
                    onClick={() => handleBulkAddTag(tag)}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-brand-50 dark:hover:bg-brand-900/30 flex items-center gap-2"
                  >
                    <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${tagClass(tag.color)}`}>
                      {tag.name}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Remove tag */}
          <div className="relative" ref={removeTagDropdownRef}>
            <button
              disabled={bulkLoading}
              onClick={() => {
                setBulkRemoveTagOpen((v) => !v);
                setBulkStatusOpen(false);
                setBulkPriorityOpen(false);
                setBulkEstimateOpen(false);
                setBulkDueDateOpen(false);
                setBulkTagOpen(false);
                void loadTags();
              }}
              className="flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              Remove tag ▾
            </button>
            {bulkRemoveTagOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 min-w-[160px] rounded-lg border border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark shadow-lg py-1">
                {allTags.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500">No tags available</div>
                ) : allTags.map((tag) => (
                  <button
                    key={tag.id}
                    onClick={() => handleBulkRemoveTag(tag)}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-brand-50 dark:hover:bg-brand-900/30 flex items-center gap-2"
                  >
                    <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${tagClass(tag.color)}`}>
                      {tag.name}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Delete */}
          <button
            disabled={bulkLoading}
            onClick={handleBulkDelete}
            className="text-xs px-2.5 py-1 rounded bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-50"
          >
            Delete
          </button>
          </div>
        </CollapsibleSection>
      )}

      <div className="flex-1 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark">
        <table className="w-full text-sm border-collapse">
          <TableHeader
            sort={sort}
            onSortChange={toggleSort}
            allChecked={allChecked}
            someChecked={someChecked}
            onToggleSelectAll={toggleSelectAll}
          />
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={10} className="text-center text-gray-400 dark:text-gray-500 text-sm py-12">No issues found</td>
              </tr>
            )}
            {sorted.map((issue) => (
              <TableRow
                key={issue.id}
                issue={issue}
                selected={selectedIds.has(issue.id)}
                onSelect={(e) => toggleSelectOne(issue.id, e)}
                onClick={() => onIssueClick(issue)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
