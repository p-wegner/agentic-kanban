import type { ProfileOption } from "../lib/workspace-helpers.js";
import type { AvailableSkill } from "./WorkspaceCard.js";
import {
  CODEX_DEFAULT_PROFILE,
  COPILOT_DEFAULT_PROFILE,
  humanizeSkillName,
  profileOptionValue,
  providerLabel,
} from "../lib/workspace-helpers.js";
import { CLAUDE_MODEL_OPTIONS, CODEX_MODEL_OPTIONS } from "@agentic-kanban/shared";

interface WorkspaceEmptyStateProps {
  actionLoading: boolean;
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  availableProfileOptions: ProfileOption[];
  selectedProfile: string;
  onSelectedProfileChange: (value: string) => void;
  selectedModel: string;
  onSelectedModelChange: (value: string) => void;
  isClaudeQuickLaunch: boolean;
  isCodexQuickLaunch: boolean;
  availableSkills: AvailableSkill[];
  onQuickLaunch: (planMode: boolean) => void;
  onSkillQuickLaunch: (skillId: string) => void;
  onCustomOptions: () => void;
}

/**
 * The "No workspaces yet" empty state with its solid-button quick-launch menu
 * (profile + model pickers, plan-mode, skill quick-launches, custom options).
 * Extracted from WorkspacePanel's render. Distinct from {@link WorkspaceQuickLaunch}
 * (the compact text-link variant shown once workspaces already exist): this one is
 * the prominent call-to-action, opens downward, and includes a Model picker.
 */
export function WorkspaceEmptyState({
  actionLoading,
  open,
  setOpen,
  availableProfileOptions,
  selectedProfile,
  onSelectedProfileChange,
  selectedModel,
  onSelectedModelChange,
  isClaudeQuickLaunch,
  isCodexQuickLaunch,
  availableSkills,
  onQuickLaunch,
  onSkillQuickLaunch,
  onCustomOptions,
}: WorkspaceEmptyStateProps) {
  return (
    <div className="text-center py-6">
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">No workspaces yet</p>
      <div className="inline-flex relative">
        <button
          onClick={() => onQuickLaunch(false)}
          disabled={actionLoading}
          className="text-sm bg-brand-600 text-white px-4 py-1.5 rounded-l hover:bg-brand-700 disabled:opacity-50"
        >
          {actionLoading ? "Creating..." : "New Workspace"}
        </button>
        <button
          onClick={() => setOpen((o) => !o)}
          disabled={actionLoading}
          className="text-sm bg-brand-600 text-white px-2 py-1.5 rounded-r border-l border-brand-500 hover:bg-brand-700 disabled:opacity-50"
          title="More options"
        >
          &#9662;
        </button>
        {open && (
          <div className="absolute top-full left-0 mt-1 w-52 bg-surface-raised dark:bg-surface-raised-dark border border-gray-200 dark:border-gray-700 rounded shadow-lg z-10">
            {availableProfileOptions.length > 0 && (
              <>
                <div className="px-3 py-1.5">
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Profile</label>
                  <select
                    value={selectedProfile}
                    onChange={(e) => onSelectedProfileChange(e.target.value)}
                    className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded px-2 py-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <option value="">Default</option>
                    {availableProfileOptions.map((option) => (
                      <option key={profileOptionValue(option)} value={profileOptionValue(option)}>
                        {providerLabel(option.provider)}: {(option.provider === "copilot" && option.name === COPILOT_DEFAULT_PROFILE) || (option.provider === "codex" && option.name === CODEX_DEFAULT_PROFILE) ? "Default" : option.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="border-t border-gray-100 dark:border-gray-800" />
              </>
            )}
            {(isClaudeQuickLaunch || isCodexQuickLaunch) && (
              <>
                <div className="px-3 py-1.5">
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Model</label>
                  <select
                    value={selectedModel}
                    onChange={(e) => onSelectedModelChange(e.target.value)}
                    className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded px-2 py-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {(isCodexQuickLaunch ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS).map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <div className="border-t border-gray-100 dark:border-gray-800" />
              </>
            )}
            <button
              onClick={() => onQuickLaunch(false)}
              className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              New Workspace
            </button>
            <button
              onClick={() => onQuickLaunch(true)}
              className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              New Workspace with Plan Mode
            </button>
            {availableSkills.length > 0 && (
              <>
                <div className="border-t border-gray-100 dark:border-gray-800" />
                <div className="px-3 py-1 text-[10px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">Skills</div>
                {availableSkills.map((skill) => (
                  <button
                    key={skill.id}
                    onClick={() => onSkillQuickLaunch(skill.id)}
                    className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2"
                    title={skill.description}
                  >
                    <span className="text-brand-600 dark:text-brand-400">✨</span>
                    {humanizeSkillName(skill.name)}
                  </button>
                ))}
              </>
            )}
            <div className="border-t border-gray-100 dark:border-gray-800" />
            <button
              onClick={onCustomOptions}
              className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400"
            >
              Custom options...
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
