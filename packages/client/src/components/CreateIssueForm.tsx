import type { CreateIssueFormState } from "../lib/boardTypes.js";
import { useRef, useEffect, useState } from "react";
import type { CreateIssueRequest, IssueEstimate } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { isHttpUrl } from "../lib/url.js";
import { showToast } from "../lib/toast.js";
import TicketMentionInput from "./TicketMentionInput.js";
import { useIssueTemplates } from "../hooks/useIssueTemplates.js";
import { useIssueEnhance } from "../hooks/useIssueEnhance.js";
import { handleImagePaste, mergeDescriptionWithImages } from "../lib/pastedImages.js";
import { EnhanceButton, UndoEnhanceButton } from "./EnhanceActions.js";
import type { AgentSkillOption } from "./IssueFormFields.js";
import {
  AgentOptionCheckbox,
  IssueEstimateSelect,
  IssueTemplateSelect,
  IssueTypeSelect,
  PastedImageStrip,
  SkillSelect,
} from "./IssueFormFields.js";

interface WorkflowTemplate {
  id: string;
  name: string;
  ticketType: string | null;
  isDefault: boolean;
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

const CHECKBOX_CLASS = "flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer";

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
  const [pastedImages, setPastedImages] = useState<string[]>(initialState?.pastedImages ?? []);
  const [issueType, setIssueType] = useState<CreateIssueRequest["issueType"]>(initialState?.issueType ?? "task");
  const [estimate, setEstimate] = useState<IssueEstimate | "">(initialState?.estimate ?? "");
  const [startWorkspace, setStartWorkspace] = useState(initialState?.startWorkspace ?? false);
  const [planMode, setPlanMode] = useState(initialState?.planMode ?? false);
  const [skipAutoReview, setSkipAutoReview] = useState(initialState?.skipAutoReview ?? false);
  const [isDirect, setIsDirect] = useState(false);
  const [externalKey, setExternalKey] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [skillId, setSkillId] = useState<string>(initialState?.skillId ?? "");
  const [skills, setSkills] = useState<AgentSkillOption[]>([]);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [workflowTemplateId, setWorkflowTemplateId] = useState<string>("");
  const [autoTemplateId, setAutoTemplateId] = useState<string>("");
  const { templates: issueTemplates } = useIssueTemplates();
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const { enhancing, preEnhanceSnapshot, enhance, undoEnhance } = useIssueEnhance({
    projectId, title, description, setTitle, setDescription,
  });

  function autoResize(el: HTMLTextAreaElement | null) {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  useEffect(() => { autoResize(titleRef.current); }, [title]);
  useEffect(() => { autoResize(descRef.current); }, [description]);

  useEffect(() => {
    if (!startWorkspace || !projectId) return;
    apiFetch<AgentSkillOption[]>(`/api/agent-skills?projectId=${projectId}`)
      .then(setSkills)
      .catch(() => {});
  }, [startWorkspace, projectId]);

  // Load workflow templates available to this project (global + project-scoped).
  useEffect(() => {
    if (!projectId) return;
    apiFetch<WorkflowTemplate[]>(`/api/workflows/templates?projectId=${projectId}`)
      .then(setTemplates)
      .catch(() => {});
  }, [projectId]);

  // Resolve the default template for the chosen ticket type. While the user
  // hasn't overridden the picker, follow the auto-resolved default.
  useEffect(() => {
    if (!projectId) return;
    apiFetch<{ templateId: string | null }>(
      `/api/workflows/resolve?projectId=${projectId}&issueType=${issueType}`,
    )
      .then((r) => {
        const resolved = r.templateId ?? "";
        setWorkflowTemplateId((prev) => (prev === "" || prev === autoTemplateId ? resolved : prev));
        setAutoTemplateId(resolved);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, issueType]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    const trimmedUrl = externalUrl.trim();
    if (trimmedUrl && !isHttpUrl(trimmedUrl)) {
      showToast("External URL must start with http:// or https://", "error");
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        title: title.trim(),
        description: mergeDescriptionWithImages(description, pastedImages) || undefined,
        issueType,
        estimate: estimate || undefined,
        statusId,
        projectId,
        workflowTemplateId: workflowTemplateId || undefined,
        externalKey: externalKey.trim() || undefined,
        externalUrl: trimmedUrl || undefined,
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
    if (!e.currentTarget.contains(e.relatedTarget) && !title.trim() && !submitting) {
      onCancel();
    }
  }

  return (
    <form
      data-testid="create-issue-form"
      onSubmit={handleSubmit}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      className="bg-surface-raised dark:bg-surface-raised-dark rounded-md shadow-sm p-3 border border-brand-200 dark:border-brand-700 space-y-2"
    >
      <textarea
        ref={titleRef}
        data-testid="create-issue-title"
        placeholder="Issue title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleTitleKeyDown}
        autoFocus
        rows={1}
        className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none overflow-y-hidden dark:bg-gray-900 dark:text-gray-100"
      />
      <TicketMentionInput
        inputRef={descRef}
        data-testid="create-issue-description"
        placeholder="Description (optional) — paste screenshots with Ctrl+V"
        value={description}
        onChange={(val) => setDescription(val)}
        onPaste={(e) => handleImagePaste(e, (dataUrl) => setPastedImages((prev) => [...prev, dataUrl]))}
        rows={2}
        className="w-full text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none overflow-y-hidden dark:bg-gray-900 dark:text-gray-100"
      />
      <PastedImageStrip
        images={pastedImages}
        onRemove={(i) => setPastedImages((prev) => prev.filter((_, j) => j !== i))}
      />
      <IssueTemplateSelect
        templates={issueTemplates}
        description={description}
        onApply={setDescription}
        className="w-full text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
      />
      <div className="flex gap-2">
        <IssueTypeSelect
          value={issueType}
          onChange={setIssueType}
          className="flex-1 text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
        />
        <IssueEstimateSelect
          value={estimate}
          onChange={setEstimate}
          emptyLabel="Est."
          title="Effort estimate"
          className="text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
        />
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="External key (optional)"
          value={externalKey}
          onChange={(e) => setExternalKey(e.target.value)}
          className="w-1/3 text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
        />
        <input
          type="url"
          placeholder="External URL (optional)"
          value={externalUrl}
          onChange={(e) => setExternalUrl(e.target.value)}
          className="flex-1 text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
        />
      </div>
      {templates.length > 0 && (
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-600 dark:text-gray-400 shrink-0" title="The workflow graph this issue flows through. Defaults to the ticket type's workflow.">
            Workflow:
          </label>
          <select
            value={workflowTemplateId}
            onChange={(e) => setWorkflowTemplateId(e.target.value)}
            className="flex-1 text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}{t.id === autoTemplateId ? " (default)" : ""}
              </option>
            ))}
          </select>
        </div>
      )}
      {canStartWorkspace && (
        <AgentOptionCheckbox
          checked={startWorkspace}
          onChange={setStartWorkspace}
          label="Start workspace"
          className={CHECKBOX_CLASS}
        />
      )}
      {canStartWorkspace && startWorkspace && (
        <div className="pl-4 space-y-1 border-l-2 border-brand-100 dark:border-brand-700">
          <AgentOptionCheckbox
            checked={planMode}
            onChange={setPlanMode}
            label="Plan mode (agent plans before implementing)"
            className={CHECKBOX_CLASS}
          />
          <AgentOptionCheckbox
            checked={skipAutoReview}
            onChange={setSkipAutoReview}
            label="Skip auto AI code review"
            className={CHECKBOX_CLASS}
          />
          <AgentOptionCheckbox
            checked={isDirect}
            onChange={setIsDirect}
            label="Work directly on current checkout (no worktree)"
            className={CHECKBOX_CLASS}
          />
          {skills.length > 0 && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-600 dark:text-gray-400 shrink-0">Skill:</label>
              <SkillSelect
                skills={skills}
                value={skillId}
                onChange={setSkillId}
                className="flex-1 text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
          )}
        </div>
      )}
      <div className="flex gap-1.5 items-center flex-wrap">
        <button
          type="submit"
          data-testid="create-issue-submit"
          disabled={!title.trim() || submitting}
          className="text-xs bg-brand-600 text-white px-3 py-1.5 rounded hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
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
        <EnhanceButton
          enhancing={enhancing}
          disabled={!title.trim() || enhancing}
          onClick={() => void enhance()}
          className="text-xs text-brand-600 dark:text-brand-400 px-2 py-1.5 hover:text-brand-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
        />
        {preEnhanceSnapshot && (
          <UndoEnhanceButton
            onClick={undoEnhance}
            className="text-xs text-gray-500 dark:text-gray-400 px-2 py-1.5 hover:text-gray-700 dark:hover:text-gray-200 flex items-center gap-1"
          />
        )}
        {onExpand && (
          <button
            type="button"
            onClick={() => onExpand({ title, description, pastedImages, issueType, estimate, startWorkspace, planMode, skipAutoReview, skillId })}
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

/** #610 — re-exported so this component's existing importers are unchanged. */
export type { CreateIssueFormState } from "../lib/boardTypes.js";
