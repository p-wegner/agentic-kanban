import type { IssueWithStatus, UpdateIssueRequest, StatusWithIssues } from "@agentic-kanban/shared";

const PRIORITY_OPTIONS = ["critical", "high", "medium", "low"] as const;
const PRIORITY_LABEL: Record<(typeof PRIORITY_OPTIONS)[number], string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

interface Tag {
  id: string;
  name: string;
  color: string | null;
}

interface Props {
  selectedIssues: IssueWithStatus[];
  hasArchivedSelection: boolean;
  boardBulkUpdating: boolean;
  columns: StatusWithIssues[];
  allTags: Tag[];
  onBulkUpdate: (updates: UpdateIssueRequest, label: string) => void;
  onBulkAddTag: (tagId: string) => void;
  onLoadTags: () => void;
  onClearSelection: () => void;
}

export function BoardBulkActionBar({
  selectedIssues,
  hasArchivedSelection,
  boardBulkUpdating,
  columns,
  allTags,
  onBulkUpdate,
  onBulkAddTag,
  onLoadTags,
  onClearSelection,
}: Props) {
  if (selectedIssues.length === 0) return null;

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-xs shadow-sm dark:border-brand-800 dark:bg-brand-950/40"
      data-testid="board-bulk-action-bar"
    >
      <span className="font-medium text-brand-700 dark:text-brand-200">
        {selectedIssues.length} selected
      </span>
      {hasArchivedSelection && (
        <span className="text-amber-700 dark:text-amber-300">
          Bulk edits are unavailable while archived cards are selected.
        </span>
      )}
      <select
        defaultValue=""
        disabled={boardBulkUpdating || hasArchivedSelection}
        onChange={(event) => {
          const statusId = event.target.value;
          const status = columns.find((col) => col.id === statusId);
          event.currentTarget.value = "";
          if (status) onBulkUpdate({ statusId }, `Moved to "${status.name}"`);
        }}
        className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-700 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        aria-label="Bulk move status"
        title={hasArchivedSelection ? "Clear archived selections before bulk editing" : "Move selected cards to status"}
      >
        <option value="">Move status...</option>
        {columns.map((col) => (
          <option key={col.id} value={col.id}>{col.name}</option>
        ))}
      </select>
      <select
        defaultValue=""
        disabled={boardBulkUpdating || hasArchivedSelection}
        onChange={(event) => {
          const priority = event.target.value as (typeof PRIORITY_OPTIONS)[number] | "";
          event.currentTarget.value = "";
          if (priority) onBulkUpdate({ priority }, `Set priority to "${PRIORITY_LABEL[priority]}"`);
        }}
        className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-700 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        aria-label="Bulk set priority"
        title={hasArchivedSelection ? "Clear archived selections before bulk editing" : "Set priority on selected cards"}
      >
        <option value="">Set priority...</option>
        {PRIORITY_OPTIONS.map((priority) => (
          <option key={priority} value={priority}>{PRIORITY_LABEL[priority]}</option>
        ))}
      </select>
      <select
        defaultValue=""
        disabled={boardBulkUpdating || hasArchivedSelection || allTags.length === 0}
        onFocus={onLoadTags}
        onChange={(event) => {
          const tagId = event.target.value;
          event.currentTarget.value = "";
          if (tagId) onBulkAddTag(tagId);
        }}
        className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-700 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        aria-label="Bulk add tag"
        title={hasArchivedSelection ? "Clear archived selections before bulk editing" : "Add a tag to selected cards"}
      >
        <option value="">Add tag...</option>
        {allTags.map((tag) => (
          <option key={tag.id} value={tag.id}>{tag.name}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={onClearSelection}
        className="rounded px-2 py-1 text-brand-600 underline-offset-2 hover:underline dark:text-brand-300"
      >
        Clear
      </button>
    </div>
  );
}
