import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { CreateIssueRequest, ProfileSelection } from "@agentic-kanban/shared";
import { CLAUDE_MODEL_OPTIONS } from "@agentic-kanban/shared";
import type { CreateIssueFormState } from "./CreateIssueForm.js";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";
import TicketMentionInput from "./TicketMentionInput.js";
import TicketMentionRenderer from "./TicketMentionRenderer.js";

interface Skill {
  id: string;
  name: string;
  description: string | null;
}

interface CreateIssuePanelProps {
  projectId: string;
  statusId: string;
  statusName?: string;
  initialState?: Partial<CreateIssueFormState>;
  onSubmit: (data: CreateIssueRequest & { startWorkspace?: boolean; planMode?: boolean; skipAutoReview?: boolean; profile?: ProfileSelection; model?: string; isDirect?: boolean; skillId?: string }) => Promise<void>;
  onClose: () => void;
  canStartWorkspace?: boolean;
}

type AgentProvider = ProfileSelection["provider"];

const COPILOT_DEFAULT_PROFILE = "default";
const CODEX_DEFAULT_PROFILE = "default";

function uniqueProfiles(profiles: string[], fallback?: string): string[] {
  const all = fallback ? [fallback, ...profiles] : profiles;
  return [...new Set(all.filter(Boolean))];
}

function defaultProfileLabel(settings: Record<string, string>): string {
  if (settings.provider === "codex") return `codex:${settings.codex_profile || CODEX_DEFAULT_PROFILE}`;
  if (settings.provider === "copilot") return `copilot:${settings.copilot_profile || COPILOT_DEFAULT_PROFILE}`;
  return `claude:${settings.claude_profile || "none"}`;
}

function profileOptionLabel(provider: AgentProvider, name: string): string {
  const isDefault = (provider === "copilot" && name === COPILOT_DEFAULT_PROFILE) ||
    (provider === "codex" && name === CODEX_DEFAULT_PROFILE);
  const displayName = isDefault ? "Default" : name;
  const providerLabel = provider === "codex" ? "Codex" : provider === "copilot" ? "Copilot" : "Claude";
  return `${providerLabel}: ${displayName}`;
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
  const [issueType, setIssueType] = useState<CreateIssueRequest["issueType"]>(initialState?.issueType ?? "task");
  const [startWorkspace, setStartWorkspace] = useState(initialState?.startWorkspace ?? false);
  const [planMode, setPlanMode] = useState(initialState?.planMode ?? false);
  const [skipAutoReview, setSkipAutoReview] = useState(initialState?.skipAutoReview ?? false);
  const [selectedProfile, setSelectedProfile] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [claudeProfiles, setClaudeProfiles] = useState<string[]>([]);
  const [codexProfiles, setCodexProfiles] = useState<string[]>([CODEX_DEFAULT_PROFILE]);
  const [copilotProfiles, setCopilotProfiles] = useState<string[]>([COPILOT_DEFAULT_PROFILE]);
  const [isDirect, setIsDirect] = useState(false);
  const [skillId, setSkillId] = useState<string>(initialState?.skillId ?? "");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [descriptionMode, setDescriptionMode] = useState<"edit" | "preview">("edit");
  const [submitting, setSubmitting] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [preEnhanceSnapshot, setPreEnhanceSnapshot] = useState<{ title: string; description: string } | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!startWorkspace || !projectId) return;
    Promise.all([
      apiFetch<Skill[]>(`/api/agent-skills?projectId=${projectId}`).catch(() => [] as Skill[]),
      apiFetch<Record<string, string>>("/api/preferences/settings").catch(() => ({} as Record<string, string>)),
      apiFetch<{ profiles: string[] }>("/api/preferences/claude-profiles").catch(() => ({ profiles: [] as string[] })),
      apiFetch<{ profiles: string[] }>("/api/preferences/codex-profiles").catch(() => ({ profiles: [CODEX_DEFAULT_PROFILE] as string[] })),
      apiFetch<{ profiles: string[] }>("/api/preferences/copilot-profiles").catch(() => ({ profiles: [COPILOT_DEFAULT_PROFILE] })),
    ]).then(([skillsData, settingsData, claudeData, codexData, copilotData]) => {
      setSkills(skillsData);
      setSettings(settingsData);
      setClaudeProfiles(claudeData.profiles);
      setCodexProfiles(uniqueProfiles(codexData.profiles, CODEX_DEFAULT_PROFILE));
      setCopilotProfiles(uniqueProfiles(copilotData.profiles, COPILOT_DEFAULT_PROFILE));
      setSelectedModel(settingsData.default_model || "");
    });
  }, [startWorkspace, projectId]);

  function profileSelection(): ProfileSelection | undefined {
    if (!selectedProfile) return undefined;
    const colonIdx = selectedProfile.indexOf(":");
    if (colonIdx === -1) return undefined;
    const provider = selectedProfile.slice(0, colonIdx) as AgentProvider;
    const name = selectedProfile.slice(colonIdx + 1);
    if ((provider !== "claude" && provider !== "codex" && provider !== "copilot") || !name) return undefined;
    return { provider, name };
  }

  const isClaudeSelected = selectedProfile === ""
    ? (settings.provider !== "codex" && settings.provider !== "copilot")
    : selectedProfile.startsWith("claude:");

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
        issueType,
        statusId,
        projectId,
        startWorkspace: startWorkspace || undefined,
        planMode: (startWorkspace && planMode) || undefined,
        skipAutoReview: (startWorkspace && skipAutoReview) || undefined,
        profile: startWorkspace ? profileSelection() : undefined,
        model: (startWorkspace && isClaudeSelected && selectedModel) || undefined,
        isDirect: (startWorkspace && isDirect) || undefined,
        skillId: (startWorkspace && skillId) || undefined,
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
      <div className="fixed right-0 top-0 h-full w-full max-w-lg bg-white dark:bg-gray-900 shadow-xl z-50 flex flex-col animate-slide-in-right">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="font-semibold text-gray-800 dark:text-gray-200 text-sm">
            New Issue{statusName ? <span className="ml-2 text-xs font-normal text-gray-400 dark:text-gray-500">in {statusName}</span> : null}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 p-1 rounded"
            title="Close"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-y-auto p-5 gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Title</label>
            <input
              ref={titleRef}
              type="text"
              placeholder="Issue title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>

          <div className="flex flex-col gap-1.5 flex-1">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Description</label>
              <div className="flex border border-gray-300 dark:border-gray-600 rounded overflow-hidden">
                <button
                  type="button"
                  onClick={() => setDescriptionMode("edit")}
                  className={`text-xs px-2 py-0.5 ${descriptionMode === "edit" ? "bg-blue-500 text-white" : "bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setDescriptionMode("preview")}
                  className={`text-xs px-2 py-0.5 border-l border-gray-300 dark:border-gray-600 ${descriptionMode === "preview" ? "bg-blue-500 text-white" : "bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"}`}
                >
                  Preview
                </button>
              </div>
            </div>
            {descriptionMode === "preview" ? (
              description ? (
                <div className="markdown-body flex-1 min-h-[200px] border border-gray-200 dark:border-gray-700 rounded px-3 py-2 dark:text-gray-200">
                  <ReactMarkdown>{description}</ReactMarkdown>
                </div>
              ) : (
                <p className="text-sm text-gray-400 dark:text-gray-500 italic flex-1 min-h-[200px] border border-gray-200 dark:border-gray-700 rounded px-3 py-2">Nothing to preview.</p>
              )
            ) : (
              <textarea
                placeholder="Describe the issue, agent instructions, acceptance criteria…"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full flex-1 min-h-[200px] text-sm border border-gray-300 dark:border-gray-600 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none dark:bg-gray-900 dark:text-gray-100"
              />
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Type</label>
            <select
              value={issueType}
              onChange={(e) => setIssueType(e.target.value as CreateIssueRequest["issueType"])}
              className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="task">Task</option>
              <option value="bug">Bug</option>
              <option value="feature">Feature</option>
              <option value="chore">Chore</option>
            </select>
          </div>

          {canStartWorkspace && (
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={startWorkspace}
                  onChange={(e) => setStartWorkspace(e.target.checked)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                Start workspace
              </label>
              {startWorkspace && (
                <div className="pl-5 flex flex-col gap-2 border-l-2 border-blue-100 dark:border-blue-800">
                  <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={planMode}
                      onChange={(e) => setPlanMode(e.target.checked)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    Plan mode (agent plans before implementing)
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={skipAutoReview}
                      onChange={(e) => setSkipAutoReview(e.target.checked)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    Skip auto AI code review
                  </label>
                  {(claudeProfiles.length > 0 || codexProfiles.length > 0 || copilotProfiles.length > 0) && (
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">Profile override</label>
                      <select
                        value={selectedProfile}
                        onChange={(e) => setSelectedProfile(e.target.value)}
                        className="flex-1 text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-900 dark:text-gray-100"
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
                      </select>
                    </div>
                  )}
                  {isClaudeSelected && (
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">Model</label>
                      <select
                        value={selectedModel}
                        onChange={(e) => setSelectedModel(e.target.value)}
                        className="flex-1 text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-900 dark:text-gray-100"
                      >
                        {CLAUDE_MODEL_OPTIONS.map((m) => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
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
                      <label className="text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">Skill</label>
                      <select
                        value={skillId}
                        onChange={(e) => setSkillId(e.target.value)}
                        className="flex-1 text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-900 dark:text-gray-100"
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
            </div>
          )}

          <div className="flex gap-2 pt-2 border-t border-gray-100 dark:border-gray-800 flex-wrap">
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
              className="text-sm text-gray-500 dark:text-gray-400 px-4 py-2 hover:text-gray-700 dark:hover:text-gray-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleEnhance}
              disabled={!title.trim() || enhancing}
              title="Enhance with AI"
              className="text-sm text-purple-600 px-3 py-2 hover:text-purple-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 ml-auto"
            >
              {enhancing ? (
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l1.5 3.5L10 8l-3.5 1.5L5 13l-1.5-3.5L0 8l3.5-1.5L5 3zM19 11l1 2.5L22.5 14l-2.5 1L19 17.5l-1-2.5L15.5 14l2.5-1L19 11z" />
                </svg>
              )}
              {enhancing ? "Enhancing…" : "Enhance with AI"}
            </button>
            {preEnhanceSnapshot && (
              <button
                type="button"
                onClick={handleUndoEnhance}
                title="Undo enhancement"
                className="text-sm text-gray-500 dark:text-gray-400 px-3 py-2 hover:text-gray-700 dark:hover:text-gray-200 flex items-center gap-1.5"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                </svg>
                Undo
              </button>
            )}
          </div>
        </form>
      </div>
    </>
  );
}
