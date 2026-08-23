import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { CreateIssueRequest, IssueEstimate, ProfileSelection } from "@agentic-kanban/shared";
import { CLAUDE_MODEL_OPTIONS, CODEX_MODEL_OPTIONS } from "@agentic-kanban/shared";
import type { CreateIssueFormState } from "./CreateIssueForm.js";
import { apiFetch } from "../lib/api.js";
import { getSettings } from "../lib/settingsStore.js";
import { MarkdownToolbar } from "./MarkdownToolbar.js";
import { useIssueTemplates } from "../hooks/useIssueTemplates.js";
import { useIssueEnhance } from "../hooks/useIssueEnhance.js";
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
import { useProjectRepos } from "../hooks/useProjectRepos.js";
import { ReposTouchedField } from "./ReposTouchedField.js";
import { buildCreateIssuePayload } from "../lib/createIssuePayload.js";
import { handleImagePaste, mergeDescriptionWithImages } from "../lib/pastedImages.js";
import {
  COPILOT_DEFAULT_PROFILE,
  CODEX_DEFAULT_PROFILE,
  PI_DEFAULT_PROFILE,
  uniqueProfiles,
  defaultProfileLabel,
  profileOptionLabel,
  providerFromSelection,
} from "../lib/profileOptionLabels.js";
import { defaultModelForProvider, type AgentProvider } from "../lib/settings-shared.js";
import { Icon } from "./Icon.js";

interface StatusOption {
  id: string;
  name: string;
}

interface CreateIssuePanelProps {
  projectId: string;
  statusId: string;
  statusName?: string;
  availableStatuses?: StatusOption[];
  initialState?: Partial<CreateIssueFormState>;
  onSubmit: (data: CreateIssueRequest & { startWorkspace?: boolean; planMode?: boolean; skipAutoReview?: boolean; profile?: ProfileSelection; model?: string; isDirect?: boolean; skillId?: string }) => Promise<void>;
  onClose: () => void;
  canStartWorkspace?: boolean;
}

const CHECKBOX_CLASS = "flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer";
const INLINE_SELECT_CLASS = "flex-1 text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100";
const FIELD_SELECT_CLASS = "text-sm border border-gray-300 dark:border-gray-600 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100";

export function CreateIssuePanel({
  projectId,
  statusId,
  statusName,
  availableStatuses,
  initialState,
  onSubmit,
  onClose,
  canStartWorkspace = false,
}: CreateIssuePanelProps) {
  const [selectedStatusId, setSelectedStatusId] = useState(statusId);
  const [title, setTitle] = useState(initialState?.title ?? "");
  const [description, setDescription] = useState(initialState?.description ?? "");
  const [pastedImages, setPastedImages] = useState<string[]>(initialState?.pastedImages ?? []);
  const [issueType, setIssueType] = useState<CreateIssueRequest["issueType"]>(initialState?.issueType ?? "task");
  const [estimate, setEstimate] = useState<IssueEstimate | "">(initialState?.estimate ?? "");
  const [reposTouched, setReposTouched] = useState<string[]>([]);
  const { repos: projectRepos, isMultiRepo } = useProjectRepos(projectId);
  const [startWorkspace, setStartWorkspace] = useState(initialState?.startWorkspace ?? false);
  const [planMode, setPlanMode] = useState(initialState?.planMode ?? false);
  const [skipAutoReview, setSkipAutoReview] = useState(initialState?.skipAutoReview ?? false);
  const [selectedProfile, setSelectedProfile] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [claudeProfiles, setClaudeProfiles] = useState<string[]>([]);
  const [codexProfiles, setCodexProfiles] = useState<string[]>([CODEX_DEFAULT_PROFILE]);
  const [copilotProfiles, setCopilotProfiles] = useState<string[]>([COPILOT_DEFAULT_PROFILE]);
  const [piProfiles, setPiProfiles] = useState<string[]>([PI_DEFAULT_PROFILE]);
  const [isDirect, setIsDirect] = useState(false);
  const [skillId, setSkillId] = useState<string>(initialState?.skillId ?? "");
  const [skills, setSkills] = useState<AgentSkillOption[]>([]);
  const [descriptionMode, setDescriptionMode] = useState<"edit" | "preview">("edit");
  const [submitting, setSubmitting] = useState(false);
  const { enhancing, preEnhanceSnapshot, enhance, undoEnhance } = useIssueEnhance({
    projectId, title, description, setTitle, setDescription,
  });
  const { templates: issueTemplates } = useIssueTemplates();
  const titleRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const descriptionWithImages = mergeDescriptionWithImages(description, pastedImages);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!startWorkspace || !projectId) return;
    void Promise.all([
      apiFetch<AgentSkillOption[]>(`/api/agent-skills?projectId=${projectId}`).catch(() => []),
      getSettings().catch(() => ({} as Record<string, string>)),
      apiFetch<{ profiles: string[] }>("/api/preferences/claude-profiles").catch(() => ({ profiles: [] as string[] })),
      apiFetch<{ profiles: string[] }>("/api/preferences/codex-profiles").catch(() => ({ profiles: [CODEX_DEFAULT_PROFILE] as string[] })),
      apiFetch<{ profiles: string[] }>("/api/preferences/copilot-profiles").catch(() => ({ profiles: [COPILOT_DEFAULT_PROFILE] })),
      apiFetch<{ profiles: string[] }>("/api/preferences/pi-profiles").catch(() => ({ profiles: [PI_DEFAULT_PROFILE] })),
    ]).then(([skillsData, settingsData, claudeData, codexData, copilotData, piData]) => {
      setSkills(skillsData);
      setSettings(settingsData);
      setClaudeProfiles(claudeData.profiles);
      setCodexProfiles(uniqueProfiles(codexData.profiles, CODEX_DEFAULT_PROFILE));
      setCopilotProfiles(uniqueProfiles(copilotData.profiles, COPILOT_DEFAULT_PROFILE));
      setPiProfiles(uniqueProfiles(piData.profiles, PI_DEFAULT_PROFILE));
      setSelectedModel(defaultModelForProvider(settingsData, ((settingsData.provider || "claude") as AgentProvider)));
    });
  }, [startWorkspace, projectId]);

  const { isClaudeSelected, isCodexSelected } = providerFromSelection(selectedProfile, settings.provider);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function handleSubmit(e: React.FormEvent, forceStart = false) {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    const start = startWorkspace || forceStart;
    setSubmitting(true);
    try {
      await onSubmit(buildCreateIssuePayload({
        title, description: descriptionWithImages, issueType, estimate,
        statusId: selectedStatusId, projectId,
        start, planMode, skipAutoReview, isDirect,
        selectedProfile, selectedModel, skillId,
        modelApplies: isClaudeSelected || isCodexSelected,
        settings,
        reposTouched: isMultiRepo ? reposTouched : undefined,
      }));
    } finally {
      setSubmitting(false);
    }
  }

  // Ctrl/Cmd+Enter creates the issue and starts a workspace immediately,
  // regardless of the "Start workspace" checkbox state.
  function handleFormKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void handleSubmit(e, true);
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 bg-black/20 z-40"
        onClick={onClose}
      />
      <div className="fixed right-0 top-0 h-full w-full max-w-lg bg-surface-raised dark:bg-surface-raised-dark shadow-xl z-50 flex flex-col animate-slide-in-right">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="font-semibold text-gray-800 dark:text-gray-200 text-sm">
            New Issue
            {availableStatuses && availableStatuses.length > 1 ? null : statusName ? (
              <span className="ml-2 text-xs font-normal text-gray-400 dark:text-gray-500">in {statusName}</span>
            ) : null}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 p-1 rounded"
            title="Close"
          >
            <Icon className="h-4 w-4" d="M6 18L18 6M6 6l12 12" />
          </button>
        </div>

        <form onSubmit={handleSubmit} onKeyDown={handleFormKeyDown} className="flex flex-col flex-1 overflow-y-auto p-5 gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Title</label>
            <input
              ref={titleRef}
              type="text"
              placeholder="Issue title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>

          <div className="flex flex-col gap-1.5 flex-1">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Description</label>
              <IssueTemplateSelect
                templates={issueTemplates}
                description={description}
                onApply={(body) => {
                  setDescription(body);
                  setDescriptionMode("edit");
                }}
                className="text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
              />
              <div className="flex border border-gray-300 dark:border-gray-600 rounded overflow-hidden">
                <button
                  type="button"
                  onClick={() => setDescriptionMode("edit")}
                  className={`text-xs px-2 py-0.5 ${descriptionMode === "edit" ? "bg-brand-500 text-white" : "bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setDescriptionMode("preview")}
                  className={`text-xs px-2 py-0.5 border-l border-gray-300 dark:border-gray-600 ${descriptionMode === "preview" ? "bg-brand-500 text-white" : "bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"}`}
                >
                  Preview
                </button>
              </div>
            </div>
            {descriptionMode === "preview" ? (
              descriptionWithImages ? (
                <div className="markdown-body flex-1 min-h-[200px] border border-gray-200 dark:border-gray-700 rounded px-3 py-2 dark:text-gray-200">
                  <ReactMarkdown>{descriptionWithImages}</ReactMarkdown>
                </div>
              ) : (
                <p className="text-sm text-gray-400 dark:text-gray-500 italic flex-1 min-h-[200px] border border-gray-200 dark:border-gray-700 rounded px-3 py-2">Nothing to preview.</p>
              )
            ) : (
              <>
                <MarkdownToolbar textareaRef={descriptionRef} value={description} onChange={setDescription} />
                <textarea
                  ref={descriptionRef}
                  placeholder="Describe the issue, agent instructions, acceptance criteria… (paste screenshots with Ctrl+V)"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onPaste={(e) => handleImagePaste(e, (dataUrl) => setPastedImages((prev) => [...prev, dataUrl]))}
                  className="w-full flex-1 min-h-[200px] text-sm border border-gray-300 dark:border-gray-600 rounded-b rounded-t-none px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none dark:bg-gray-900 dark:text-gray-100"
                />
                <PastedImageStrip
                  images={pastedImages}
                  onRemove={(i) => setPastedImages((prev) => prev.filter((_, j) => j !== i))}
                  className="flex flex-wrap gap-2 mt-2"
                  imageClassName="h-16 w-auto rounded border border-gray-200 dark:border-gray-700 object-cover"
                />
              </>
            )}
          </div>

          <div className="flex gap-3">
            <div className="flex flex-col gap-1.5 flex-1">
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Type</label>
              <IssueTypeSelect
                value={issueType}
                onChange={setIssueType}
                className={`w-full ${FIELD_SELECT_CLASS}`}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Estimate</label>
              <IssueEstimateSelect
                value={estimate}
                onChange={setEstimate}
                emptyLabel="None"
                className={FIELD_SELECT_CLASS}
              />
            </div>
          </div>

          {isMultiRepo && (
            <ReposTouchedField repos={projectRepos} selected={reposTouched} onChange={setReposTouched} />
          )}

          {availableStatuses && availableStatuses.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Column</label>
              <select
                value={selectedStatusId}
                onChange={(e) => setSelectedStatusId(e.target.value)}
                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
              >
                {availableStatuses.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}

          {canStartWorkspace && (
            <div className="flex flex-col gap-2">
              <AgentOptionCheckbox
                checked={startWorkspace}
                onChange={setStartWorkspace}
                label="Start workspace"
                className={CHECKBOX_CLASS}
              />
              {startWorkspace && (
                <div className="pl-5 flex flex-col gap-2 border-l-2 border-brand-100 dark:border-brand-700">
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
                  {(claudeProfiles.length > 0 || codexProfiles.length > 0 || copilotProfiles.length > 0 || piProfiles.length > 0) && (
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">Profile override</label>
                      <select
                        value={selectedProfile}
                        onChange={(e) => setSelectedProfile(e.target.value)}
                        className={INLINE_SELECT_CLASS}
                      >
                        <option value="">Default ({defaultProfileLabel(settings)})</option>
                        {claudeProfiles.length > 0 && (
                          <optgroup label="Claude">
                            {claudeProfiles.map((p) => (
                              <option key={`claude:${p}`} value={`claude:${p}`}>{profileOptionLabel("claude", p)}</option>
                            ))}
                          </optgroup>
                        )}
                        <optgroup label="Codex">
                          {codexProfiles.map((p) => (
                            <option key={`codex:${p}`} value={`codex:${p}`}>{profileOptionLabel("codex", p)}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Copilot">
                          {copilotProfiles.map((p) => (
                            <option key={`copilot:${p}`} value={`copilot:${p}`}>{profileOptionLabel("copilot", p)}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Pi">
                          {piProfiles.map((p) => (
                            <option key={`pi:${p}`} value={`pi:${p}`}>{profileOptionLabel("pi", p)}</option>
                          ))}
                        </optgroup>
                      </select>
                    </div>
                  )}
                  {(isClaudeSelected || isCodexSelected) && (
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">Model</label>
                      <select
                        value={selectedModel}
                        onChange={(e) => setSelectedModel(e.target.value)}
                        className={INLINE_SELECT_CLASS}
                      >
                        {(isCodexSelected ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS).map((m) => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <AgentOptionCheckbox
                    checked={isDirect}
                    onChange={setIsDirect}
                    label="Work directly on current checkout (no worktree)"
                    className={CHECKBOX_CLASS}
                  />
                  {skills.length > 0 && (
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">Skill</label>
                      <SkillSelect
                        skills={skills}
                        value={skillId}
                        onChange={setSkillId}
                        className={INLINE_SELECT_CLASS}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2 pt-2 border-t border-gray-100 dark:border-gray-800 flex-wrap">
            <button
              type="submit"
              disabled={!title.trim() || submitting}
              title="Ctrl+Enter to create and start a workspace"
              className="text-sm bg-brand-600 text-white px-4 py-2 rounded hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting
                ? (startWorkspace ? "Creating..." : "Adding...")
                : (startWorkspace ? "Create & Start" : "Add Issue")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-sm text-gray-500 dark:text-gray-400 px-4 py-2 hover:text-gray-700 dark:hover:text-gray-200"
            >
              Cancel
            </button>
            <EnhanceButton
              enhancing={enhancing}
              disabled={!title.trim() || enhancing}
              onClick={() => void enhance()}
              iconClassName="h-4 w-4"
              label="Enhance with AI"
              busyLabel="Enhancing…"
              className="text-sm text-brand-600 dark:text-brand-400 px-3 py-2 hover:text-brand-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 ml-auto"
            />
            {preEnhanceSnapshot && (
              <UndoEnhanceButton
                onClick={undoEnhance}
                iconClassName="h-4 w-4"
                className="text-sm text-gray-500 dark:text-gray-400 px-3 py-2 hover:text-gray-700 dark:hover:text-gray-200 flex items-center gap-1.5"
              />
            )}
          </div>
        </form>
      </div>
    </>
  );
}
