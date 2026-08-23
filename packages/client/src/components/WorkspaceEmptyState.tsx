import type { WorkspaceQuickLaunchCommonProps } from "./WorkspaceQuickLaunchMenu.js";
import { WorkspaceQuickLaunchMenu } from "./WorkspaceQuickLaunchMenu.js";

interface WorkspaceEmptyStateProps extends WorkspaceQuickLaunchCommonProps {
  actionLoading: boolean;
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  selectedModel: string;
  onSelectedModelChange: (value: string) => void;
  isClaudeQuickLaunch: boolean;
  isCodexQuickLaunch: boolean;
}

/**
 * The "No workspaces yet" empty state with its solid-button quick-launch menu
 * (profile + model pickers, plan-mode, skill quick-launches, custom options).
 * Extracted from WorkspacePanel's render. Distinct from {@link WorkspaceQuickLaunch}
 * (the compact text-link variant shown once workspaces already exist): this one is
 * the prominent call-to-action, opens downward, and includes a Model picker.
 *
 * Those three differences are all this component still holds — the menu body itself is
 * {@link WorkspaceQuickLaunchMenu}, shared with the compact variant (#772).
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
          <WorkspaceQuickLaunchMenu
            placement="down"
            availableProfileOptions={availableProfileOptions}
            selectedProfile={selectedProfile}
            onSelectedProfileChange={onSelectedProfileChange}
            model={
              isClaudeQuickLaunch || isCodexQuickLaunch
                ? { selectedModel, onSelectedModelChange, isCodex: isCodexQuickLaunch }
                : null
            }
            availableSkills={availableSkills}
            onQuickLaunch={onQuickLaunch}
            onSkillQuickLaunch={onSkillQuickLaunch}
            onCustomOptions={onCustomOptions}
          />
        )}
      </div>
    </div>
  );
}
