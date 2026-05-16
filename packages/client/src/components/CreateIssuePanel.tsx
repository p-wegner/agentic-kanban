import { useEffect, useRef, useState } from "react";
import type { CreateIssueRequest } from "@agentic-kanban/shared";
import type { CreateIssueFormState } from "./CreateIssueForm.js";

interface CreateIssuePanelProps {
  projectId: string;
  statusId: string;
  statusName?: string;
  initialState?: Partial<CreateIssueFormState>;
  onSubmit: (data: CreateIssueRequest & { startWorkspace?: boolean; planMode?: boolean; skipAutoReview?: boolean }) => Promise<void>;
  onClose: () => void;
  canStartWorkspace?: boolean;
}

export function CreateIssuePanel({
  projectId,
  statusId,
  statusName,
  initialState,
  onSubmit,
  onClose,
  canStartWorkspace = false,
}: CreateIssuePanelProps) {
  const [title, setTitle] = useState(initialState?.title ?? "");
  const [description, setDescription] = useState(initialState?.description ?? "");
  const [priority, setPriority] = useState<CreateIssueRequest["priority"]>(initialState?.priority ?? "medium");
  const [startWorkspace, setStartWorkspace] = useState(initialState?.startWorkspace ?? false);
  const [planMode, setPlanMode] = useState(initialState?.planMode ?? false);
  const [skipAutoReview, setSkipAutoReview] = useState(initialState?.skipAutoReview ?? false);
  const [submitting, setSubmitting] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        statusId,
        projectId,
        startWorkspace: startWorkspace || undefined,
        planMode: (startWorkspace && planMode) || undefined,
        skipAutoReview: (startWorkspace && skipAutoReview) || undefined,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 bg-black/20 z-40"
        onClick={onClose}
      />
      <div className="fixed right-0 top-0 h-full w-full max-w-lg bg-white shadow-xl z-50 flex flex-col animate-slide-in-right">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="font-semibold text-gray-800 text-sm">
            New Issue{statusName ? <span className="ml-2 text-xs font-normal text-gray-400">in {statusName}</span> : null}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded"
            title="Close"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-y-auto p-5 gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-600">Title</label>
            <input
              ref={titleRef}
              type="text"
              placeholder="Issue title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full text-sm border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div className="flex flex-col gap-1.5 flex-1">
            <label className="text-xs font-medium text-gray-600">Description</label>
            <textarea
              placeholder="Describe the issue, agent instructions, acceptance criteria…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full flex-1 min-h-[200px] text-sm border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-600">Priority</label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as CreateIssueRequest["priority"])}
              className="w-full text-sm border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>

          {canStartWorkspace && (
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={startWorkspace}
                  onChange={(e) => setStartWorkspace(e.target.checked)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                Start workspace
              </label>
              {startWorkspace && (
                <div className="pl-5 flex flex-col gap-2 border-l-2 border-blue-100">
                  <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={planMode}
                      onChange={(e) => setPlanMode(e.target.checked)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    Plan mode (agent plans before implementing)
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={skipAutoReview}
                      onChange={(e) => setSkipAutoReview(e.target.checked)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    Skip auto AI code review
                  </label>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2 pt-2 border-t border-gray-100">
            <button
              type="submit"
              disabled={!title.trim() || submitting}
              className="text-sm bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting
                ? (startWorkspace ? "Creating..." : "Adding...")
                : (startWorkspace ? "Create & Start" : "Add Issue")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-sm text-gray-500 px-4 py-2 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
