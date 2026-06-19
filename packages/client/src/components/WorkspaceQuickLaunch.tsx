import type { ProfileOption } from "../lib/workspace-helpers.js";
import type { AvailableSkill } from "./WorkspaceCard.js";
import {
  CODEX_DEFAULT_PROFILE,
  COPILOT_DEFAULT_PROFILE,
  humanizeSkillName,
  profileOptionValue,
  providerLabel,
} from "../lib/workspace-helpers.js";

interface WorkspaceQuickLaunchProps {
  hasWorkspaces: boolean;
  actionLoading: boolean;
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  availableProfileOptions: ProfileOption[];
  selectedProfile: string;
  onSelectedProfileChange: (value: string) => void;
  availableSkills: AvailableSkill[];
  onQuickLaunch: (planMode: boolean) => void;
  onSkillQuickLaunch: (skillId: string) => void;
  onCustomOptions: () => void;
}

/**
 * The "+ New Workspace" split-button + dropdown (profile picker, plan-mode,
 * skill quick-launches, custom options). Extracted from WorkspacePanel's render.
 */
export function WorkspaceQuickLaunch({
  hasWorkspaces,
  actionLoading,
  open,
  setOpen,
  availableProfileOptions,
  selectedProfile,
  onSelectedProfileChange,
  availableSkills,
  onQuickLaunch,
  onSkillQuickLaunch,
  onCustomOptions,
}: WorkspaceQuickLaunchProps) {
  if (!hasWorkspaces) return null;
  return (
    <div className="inline-flex relative">
      <button
        onClick={() => onQuickLaunch(false)}
        disabled={actionLoading}
        className="text-sm text-blue-600 hover:text-blue-700 disabled:opacity-50"
      >
        + New Workspace
      </button>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={actionLoading}
        className="text-sm text-blue-600 hover:text-blue-700 disabled:opacity-50 px-1"
        title="More options"
      >
        &#9662;
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-52 bg-surface-raised dark:bg-surface-raised-dark border border-gray-200 dark:border-gray-700 rounded shadow-lg z-10">
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
  );
}
