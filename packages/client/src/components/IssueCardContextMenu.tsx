import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { apiFetch, apiPatch } from "../lib/api.js";
import { showToast } from "./Toast.js";
import type { QuickUpdateCallbacks, StatusOption } from "./IssueCard.js";

export function IssueCardContextMenu({
  issue,
  position,
  menuRef,
  cardRef,
  onClose,
  showResume,
  showDiff,
  showStartWorkspace,
  showDryRun,
  showMoveToNext,
  hasAnyAction,
  nextStatusName,
  ws,
  quickUpdate,
  allStatuses,
  onDeleteIssue,
  onDuplicate,
  onWorkspaceClick,
  onOpenDiff,
  onStartWorkspace,
  onDryRun,
  onMoveToNext,
}: {
  issue: IssueWithStatus;
  position: { x: number; y: number };
  menuRef: React.MutableRefObject<HTMLDivElement | null>;
  cardRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  showResume: boolean;
  showDiff: boolean;
  showStartWorkspace: boolean;
  showDryRun: boolean;
  showMoveToNext: boolean;
  hasAnyAction: boolean;
  nextStatusName?: string;
  ws: IssueWithStatus["workspaceSummary"];
  quickUpdate?: QuickUpdateCallbacks;
  allStatuses?: StatusOption[];
  onDeleteIssue?: (issueId: string) => void;
  onDuplicate?: (issue: IssueWithStatus) => void;
  onWorkspaceClick?: (issue: IssueWithStatus, workspaceId?: string) => void;
  onOpenDiff?: (issue: IssueWithStatus, workspaceId: string) => void;
  onStartWorkspace?: (issue: IssueWithStatus) => void;
  onDryRun?: (issue: IssueWithStatus) => void;
  onMoveToNext?: (issue: IssueWithStatus) => void;
}) {
  const [prioritySubmenuOpen, setPrioritySubmenuOpen] = useState(false);
  const [statusSubmenuOpen, setStatusSubmenuOpen] = useState(false);

  useEffect(() => {
    const firstItem = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    firstItem?.focus();

    function handlePointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        cardRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  function handleMenuKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = e.key === "ArrowDown"
      ? (currentIndex + 1) % items.length
      : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex].focus();
  }

  async function copyIssueReference() {
    const prefix = issue.issueNumber != null ? `#${issue.issueNumber}` : issue.id;
    try {
      await navigator.clipboard.writeText(`${prefix} ${issue.title}`);
      showToast("Issue reference copied", "success");
    } catch {
      showToast("Failed to copy issue reference", "error");
    } finally {
      onClose();
    }
  }

  function runContextAction(action: () => void) {
    action();
    onClose();
  }

  async function handleChangePriority(priority: string) {
    onClose();
    if (quickUpdate?.onPriorityChange) {
      await quickUpdate.onPriorityChange(issue.id, priority);
    }
  }

  async function handleMoveToStatus(statusName: string) {
    onClose();
    try {
      await apiPatch(`/api/issues/${issue.id}`, { statusName });
    } catch {
      showToast("Failed to move issue", "error");
    }
  }

  function handleDeleteIssueClick() {
    const confirmed = window.confirm(`Delete "${issue.title}"? This cannot be undone.`);
    if (!confirmed) return;
    onClose();
    onDeleteIssue?.(issue.id);
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Issue actions for ${issue.title}`}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={handleMenuKeyDown}
      className="fixed z-50 w-52 rounded-md border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
      style={{ left: position.x, top: position.y }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={copyIssueReference}
        className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none dark:text-gray-200 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
      >
        <svg className="h-3.5 w-3.5 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
        <span className="truncate">Copy issue reference</span>
      </button>
      {quickUpdate?.onTogglePinned && (
        <button
          type="button"
          role="menuitem"
          onClick={() => runContextAction(() => quickUpdate.onTogglePinned!(issue.id, !issue.pinned))}
          className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none dark:text-gray-200 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
        >
          <svg className="h-3.5 w-3.5 shrink-0 text-amber-400" fill={issue.pinned ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.562.562 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
          </svg>
          <span className="truncate">{issue.pinned ? "Unpin issue" : "Pin issue"}</span>
        </button>
      )}
      {hasAnyAction && <div className="my-1 border-t border-gray-100 dark:border-gray-800" />}
      {showResume && (
        <button
          type="button"
          role="menuitem"
          onClick={() => runContextAction(() => onWorkspaceClick!(issue, ws?.main?.id))}
          className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none dark:text-gray-200 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
        >
          <svg className="h-3.5 w-3.5 shrink-0 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
          </svg>
          <span className="truncate">Resume</span>
        </button>
      )}
      {showDiff && (
        <button
          type="button"
          role="menuitem"
          onClick={() => runContextAction(() => onOpenDiff!(issue, ws!.main!.id!))}
          className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none dark:text-gray-200 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
        >
          <svg className="h-3.5 w-3.5 shrink-0 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z" />
          </svg>
          <span className="truncate">View Diff</span>
        </button>
      )}
      {showStartWorkspace && (
        <button
          type="button"
          role="menuitem"
          onClick={() => runContextAction(() => onStartWorkspace!(issue))}
          className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none dark:text-gray-200 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
        >
          <svg className="h-3.5 w-3.5 shrink-0 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          <span className="truncate">Start Workspace</span>
        </button>
      )}
      {showDryRun && (
        <button
          type="button"
          role="menuitem"
          onClick={() => runContextAction(() => onDryRun!(issue))}
          className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none dark:text-gray-200 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
        >
          <svg className="h-3.5 w-3.5 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7Z" />
          </svg>
          <span className="truncate">Dry Run Preview</span>
        </button>
      )}
      {showMoveToNext && (
        <button
          type="button"
          role="menuitem"
          onClick={() => runContextAction(() => onMoveToNext!(issue))}
          className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none dark:text-gray-200 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
        >
          <svg className="h-3.5 w-3.5 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
          </svg>
          <span className="truncate">Move to {nextStatusName}</span>
        </button>
      )}
      {onDuplicate && (
        <>
          <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
          <button
            type="button"
            role="menuitem"
            onClick={() => runContextAction(() => onDuplicate(issue))}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none dark:text-gray-200 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
          >
            <svg className="h-3.5 w-3.5 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <span className="truncate">Duplicate issue</span>
          </button>
        </>
      )}
      <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
      {quickUpdate?.onPriorityChange && (
        <div className="relative">
          <button
            type="button"
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); setPrioritySubmenuOpen((v) => !v); setStatusSubmenuOpen(false); }}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none dark:text-gray-200 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
          >
            <svg className="h-3.5 w-3.5 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h18M3 12h12M3 17h6" />
            </svg>
            <span className="flex-1 truncate">Change priority</span>
            <svg className="h-3 w-3 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
          {prioritySubmenuOpen && (
            <div className="absolute left-full top-0 ml-1 w-36 rounded-md border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900 z-10">
              {(["critical", "high", "medium", "low"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="menuitem"
                  onClick={() => handleChangePriority(p)}
                  className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs hover:bg-gray-50 focus:bg-gray-50 focus:outline-none dark:hover:bg-gray-800 dark:focus:bg-gray-800 ${issue.priority === p ? "font-semibold text-brand-700 dark:text-brand-300" : "text-gray-700 dark:text-gray-200"}`}
                >
                  <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${p === "critical" ? "bg-red-500" : p === "high" ? "bg-orange-500" : p === "medium" ? "bg-yellow-400" : "bg-gray-400"}`} />
                  <span className="capitalize">{p}</span>
                  {issue.priority === p && <svg className="ml-auto h-3 w-3 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {allStatuses && allStatuses.length > 0 && (
        <div className="relative">
          <button
            type="button"
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); setStatusSubmenuOpen((v) => !v); setPrioritySubmenuOpen(false); }}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none dark:text-gray-200 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
          >
            <svg className="h-3.5 w-3.5 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m-8 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
            <span className="flex-1 truncate">Move to status</span>
            <svg className="h-3 w-3 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
          {statusSubmenuOpen && (
            <div className="absolute left-full top-0 ml-1 w-40 rounded-md border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900 z-10">
              {allStatuses.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="menuitem"
                  onClick={() => handleMoveToStatus(s.name)}
                  className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs hover:bg-gray-50 focus:bg-gray-50 focus:outline-none dark:hover:bg-gray-800 dark:focus:bg-gray-800 ${issue.statusName === s.name ? "font-semibold text-brand-700 dark:text-brand-300" : "text-gray-700 dark:text-gray-200"}`}
                >
                  <span className="truncate">{s.name}</span>
                  {issue.statusName === s.name && <svg className="ml-auto h-3 w-3 shrink-0 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {onDeleteIssue && (
        <button
          type="button"
          role="menuitem"
          onClick={handleDeleteIssueClick}
          className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 focus:bg-red-50 focus:outline-none dark:text-red-400 dark:hover:bg-red-900/20 dark:focus:bg-red-900/20"
        >
          <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          <span className="truncate">Delete issue</span>
        </button>
      )}
    </div>,
    document.body,
  );
}
