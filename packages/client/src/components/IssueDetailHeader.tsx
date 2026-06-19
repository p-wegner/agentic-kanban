// The header bar of IssueDetailPanel: issue number + title chip and the action
// toolbar (edit/save/cancel, chat, visual-verify, pin, decompose, duplicate,
// delete, panel-mode cycle, close). Extracted to lift the densest button cluster
// out of the panel's god-render. Purely presentational: every action is an intent
// callback supplied by the container, so this component owns no state.
import type { MouseEvent } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import type { PanelMode } from "../hooks/usePanelLayout.js";
import { CopyButton, CopyLinkButton } from "./IssueCopyButtons.js";

interface IssueDetailHeaderProps {
  issue: IssueWithStatus;
  editing: boolean;
  saving: boolean;
  title: string;
  panelMode: PanelMode;
  isVisualVerify: boolean;
  togglingVisualVerify: boolean;
  duplicating: boolean;
  confirmDelete: boolean;
  /** Whether the "decompose into subtasks" action applies (long description or epic tag). */
  canDecompose: boolean;
  /** Drag-to-move handler; the container decides when dragging is allowed via panelMode. */
  onHeaderMouseDown: (e: MouseEvent<HTMLDivElement>) => void;
  onSave: () => void;
  onCancelEdit: () => void;
  onStartEditing: () => void;
  /** Open the butler with this ticket's context (#838). Omitted → button hidden. */
  onChat?: () => void;
  onToggleVisualVerify: () => void;
  onTogglePinned: () => void;
  onDecompose: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onCyclePanelMode: () => void;
  onClose: () => void;
}

export function IssueDetailHeader({
  issue,
  editing,
  saving,
  title,
  panelMode,
  isVisualVerify,
  togglingVisualVerify,
  duplicating,
  confirmDelete,
  canDecompose,
  onHeaderMouseDown,
  onSave,
  onCancelEdit,
  onStartEditing,
  onChat,
  onToggleVisualVerify,
  onTogglePinned,
  onDecompose,
  onDuplicate,
  onDelete,
  onCyclePanelMode,
  onClose,
}: IssueDetailHeaderProps) {
  const draggable = panelMode === "sidebar" || panelMode === "modal";
  return (
    <div
      className={`flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 ${editing ? "bg-amber-50/60 dark:bg-amber-950/20" : ""} ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${panelMode === "modal" ? "rounded-t-lg" : ""}`}
      onMouseDown={draggable ? onHeaderMouseDown : undefined}
    >
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
        {issue.issueNumber != null && (
          <span className="flex items-center gap-1">
            <span className="text-gray-400 dark:text-gray-500 font-mono">#{issue.issueNumber}</span>
            <CopyButton text={`#${issue.issueNumber} ${issue.title}`} />
          </span>
        )}
        Issue Details
        {editing && (
          <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
            editing
          </span>
        )}
      </h2>
      <div className="flex items-center gap-1">
        {editing ? (
          <>
            <button
              onClick={onSave}
              disabled={saving || !title.trim()}
              aria-label="Save issue"
              className="text-xs font-medium bg-brand-600 text-white px-2.5 py-1 rounded hover:bg-brand-700 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              onClick={onCancelEdit}
              className="text-xs font-medium text-gray-500 dark:text-gray-400 px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              onClick={onStartEditing}
              title="Edit issue"
              aria-label="Edit issue"
              className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 p-0.5 rounded transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            {issue.issueNumber != null && (
              <CopyLinkButton issueNumber={issue.issueNumber} />
            )}
            {onChat && (
              <button
                onClick={onChat}
                title="Chat about this ticket with the butler — what took so long, where agents failed, missing context"
                aria-label="Chat about this ticket with the butler"
                className="text-gray-400 dark:text-gray-500 hover:text-brand-600 dark:hover:text-brand-400 p-0.5 rounded transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </button>
            )}
            <button
              onClick={onToggleVisualVerify}
              disabled={togglingVisualVerify}
              title={isVisualVerify ? "Unmark visual verification" : "Mark for visual verification"}
              className={`p-0.5 rounded transition-colors disabled:opacity-50 ${isVisualVerify ? "text-amber-500 hover:text-amber-600" : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </button>
            <button
              onClick={onTogglePinned}
              title={issue.pinned ? "Unpin issue" : "Pin issue"}
              aria-label={issue.pinned ? "Unpin issue" : "Pin issue"}
              className={`p-0.5 rounded transition-colors ${issue.pinned ? "text-amber-400 hover:text-amber-500" : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill={issue.pinned ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.562.562 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
              </svg>
            </button>
            {canDecompose && (
              <button
                onClick={onDecompose}
                title="Decompose into subtasks"
                className="text-purple-400 dark:text-purple-500 hover:text-purple-600 dark:hover:text-purple-300 p-0.5 rounded transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h8m-8 4h8" />
                </svg>
              </button>
            )}
            <button
              onClick={onDuplicate}
              disabled={duplicating}
              title="Duplicate issue"
              aria-label="Duplicate issue"
              className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 p-0.5 rounded transition-colors disabled:opacity-50"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
            <button
              data-delete-issue-action
              onClick={onDelete}
              disabled={saving}
              aria-label={confirmDelete ? "Confirm delete issue" : "Delete issue"}
              title={confirmDelete ? "Click again to confirm delete" : "Delete issue"}
              className={`p-0.5 rounded transition-colors disabled:opacity-50 ${confirmDelete ? "text-red-600 dark:text-red-400" : "text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400"}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </>
        )}
        <button
          onClick={onCyclePanelMode}
          title={panelMode === "sidebar" ? "Expand to modal" : panelMode === "modal" ? "Expand to fullscreen" : "Collapse to sidebar"}
          className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 p-0.5 rounded"
        >
          {panelMode === "fullscreen" ? (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 9L4 4m0 0h5m-5 0v5M15 9l5-5m0 0h-5m5 0v5M9 15l-5 5m0 0h5m-5 0v-5M15 15l5 5m0 0h-5m5 0v-5" />
            </svg>
          ) : panelMode === "modal" ? (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5M20 8V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5M20 16v4m0 0h-4m4 0l-5-5" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5M20 8V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5M20 16v4m0 0h-4m4 0l-5-5" />
            </svg>
          )}
        </button>
        <button
          onClick={onClose}
          className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
        >
          &times;
        </button>
      </div>
    </div>
  );
}
