import { useRef, useEffect, useState } from "react";
import type { CreateIssueRequest } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";
import TicketMentionInput from "./TicketMentionInput.js";

interface Skill {
  id: string;
  name: string;
  description: string | null;
}

interface Skill {
  id: string;
  name: string;
  description: string | null;
}

export interface CreateIssueFormState {
  title: string;
  description: string;
  issueType: CreateIssueRequest["issueType"];
  startWorkspace: boolean;
  planMode: boolean;
  skipAutoReview: boolean;
  skillId?: string;
}

interface CreateIssueFormProps {
  projectId: string;
  statusId: string;
  onSubmit: (data: CreateIssueRequest & { startWorkspace?: boolean; planMode?: boolean; skipAutoReview?: boolean; isDirect?: boolean; skillId?: string }) => Promise<void>;
  onCancel: () => void;
  canStartWorkspace?: boolean;
  onExpand?: (state: CreateIssueFormState) => void;
  initialState?: Partial<CreateIssueFormState>;
}

export function CreateIssueForm({
  projectId,
  statusId,
  onSubmit,
  onCancel,
  canStartWorkspace = false,
  onExpand,
  initialState,
}: CreateIssueFormProps) {
  const [title, setTitle] = useState(initialState?.title ?? "");
  const [description, setDescription] = useState(initialState?.description ?? "");
  const [issueType, setIssueType] = useState<CreateIssueRequest["issueType"]>(initialState?.issueType ?? "task");
  const [startWorkspace, setStartWorkspace] = useState(initialState?.startWorkspace ?? false);
  const [planMode, setPlanMode] = useState(initialState?.planMode ?? false);
  const [skipAutoReview, setSkipAutoReview] = useState(initialState?.skipAutoReview ?? false);
  const [isDirect, setIsDirect] = useState(false);
  const [skillId, setSkillId] = useState<string>(initialState?.skillId ?? "");
  const [skills, setSkills] = useState<Skill[]>([]);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [preEnhanceSnapshot, setPreEnhanceSnapshot] = useState<{ title: string; description: string } | null>(null);

  function autoResize(el: HTMLTextAreaElement | null) {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  useEffect(() => { autoResize(titleRef.current); }, [title]);
  useEffect(() => { autoResize(descRef.current); }, [description]);

  useEffect(() => {
    if (!startWorkspace || !projectId) return;
    apiFetch<Skill[]>(`/api/agent-skills?projectId=${projectId}`)
      .then(setSkills)
      .catch(() => {});
  }, [startWorkspace, projectId]);

  async function handleEnhance() {
    if (!title.trim() || enhancing) return;
    setEnhancing(true);
    try {
      setPreEnhanceSnapshot({ title, description });
      const result = await apiFetch<{ title: string; description: string }>("/api/issues/enhance", {
        method: "POST",
        body: JSON.stringify({ title, description, projectId }),
      });
      setTitle(result.title);
      setDescription(result.description);
    } catch (err) {
      setPreEnhanceSnapshot(null);
      showToast(err instanceof Error ? err.message : "Enhancement failed", "error");
    } finally {
      setEnhancing(false);
    }
  }

  function handleUndoEnhance() {
    if (!preEnhanceSnapshot) return;
    setTitle(preEnhanceSnapshot.title);
    setDescription(preEnhanceSnapshot.description);
    setPreEnhanceSnapshot(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim() || undefined,
        issueType,
        statusId,
        projectId,
        startWorkspace: startWorkspace || undefined,
        planMode: (startWorkspace && planMode) || undefined,
        skipAutoReview: (startWorkspace && skipAutoReview) || undefined,
        isDirect: (startWorkspace && isDirect) || undefined,
        skillId: (startWorkspace && skillId) || undefined,
      });
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onCancel();
    }
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
      return;
    }
    // Submit on Enter (prevent newline in title)
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (title.trim() && !submitting) {
        e.currentTarget.closest("form")?.requestSubmit();
      }
    }
  }

  function handleBlur(e: React.FocusEvent) {
    // If focus moves outside the form and title is empty, cancel
    if (!e.currentTarget.contains(e.relatedTarget as Node) && !title.trim() && !submitting) {
      onCancel();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      className="bg-white dark:bg-gray-900 rounded-md shadow-sm p-3 border border-blue-200 dark:border-blue-800 space-y-2"
    >
      <textarea
        ref={titleRef}
        placeholder="Issue title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleTitleKeyDown}
        autoFocus
        rows={1}
        className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none overflow-y-hidden dark:bg-gray-900 dark:text-gray-100"
      />
      <TicketMentionInput
        inputRef={descRef}
        placeholder="Description (optional)"
        value={description}
        onChange={(val) => setDescription(val)}
        rows={2}
        className="w-full text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none overflow-y-hidden dark:bg-gray-900 dark:text-gray-100"
      />
      <select
        value={issueType}
        onChange={(e) => setIssueType(e.target.value as CreateIssueRequest["issueType"])}
        className="w-full text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-900 dark:text-gray-100"
      >
        <option value="task">Task</option>
        <option value="bug">Bug</option>
        <option value="feature">Feature</option>
        <option value="chore">Chore</option>
      </select>
      {canStartWorkspace && (
        <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={startWorkspace}
            onChange={(e) => setStartWorkspace(e.target.checked)}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          Start workspace
        </label>
      )}
      {canStartWorkspace && startWorkspace && (
        <div className="pl-4 space-y-1 border-l-2 border-blue-100 dark:border-blue-800">
          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={planMode}
              onChange={(e) => setPlanMode(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Plan mode (agent plans before implementing)
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={skipAutoReview}
              onChange={(e) => setSkipAutoReview(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Skip auto AI code review
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={isDirect}
              onChange={(e) => setIsDirect(e.target.checked)}
              className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
            />
            Work directly on current checkout (no worktree)
          </label>
          {skills.length > 0 && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-600 dark:text-gray-400 shrink-0">Skill:</label>
              <select
                value={skillId}
                onChange={(e) => setSkillId(e.target.value)}
                className="flex-1 text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-900 dark:text-gray-100"
              >
                <option value="">None</option>
                {skills.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
      <div className="flex gap-1.5 items-center flex-wrap">
        <button
          type="submit"
          disabled={!title.trim() || submitting}
          className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting
            ? (startWorkspace ? "Creating..." : "Adding...")
            : (startWorkspace ? "Create & Start" : "Add")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-gray-500 dark:text-gray-400 px-3 py-1.5 hover:text-gray-700 dark:hover:text-gray-200"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleEnhance}
          disabled={!title.trim() || enhancing}
          title="Enhance with AI"
          className="text-xs text-purple-600 px-2 py-1.5 hover:text-purple-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
        >
          {enhancing ? (
            <svg className="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l1.5 3.5L10 8l-3.5 1.5L5 13l-1.5-3.5L0 8l3.5-1.5L5 3zM19 11l1 2.5L22.5 14l-2.5 1L19 17.5l-1-2.5L15.5 14l2.5-1L19 11z" />
            </svg>
          )}
          {enhancing ? "Enhancing..." : "Enhance"}
        </button>
        {preEnhanceSnapshot && (
          <button
            type="button"
            onClick={handleUndoEnhance}
            title="Undo enhancement"
            className="text-xs text-gray-500 dark:text-gray-400 px-2 py-1.5 hover:text-gray-700 dark:hover:text-gray-200 flex items-center gap-1"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
            Undo
          </button>
        )}
        {onExpand && (
          <button
            type="button"
            onClick={() => onExpand({ title, description, issueType, startWorkspace, planMode, skipAutoReview, skillId })}
            className="ml-auto text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 p-1 rounded"
            title="Expand form"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          </button>
        )}
      </div>
    </form>
  );
}
