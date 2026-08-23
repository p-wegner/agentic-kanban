import type { WorkspaceQuickLaunchCommonProps } from "./WorkspaceQuickLaunchMenu.js";
import { WorkspaceQuickLaunchMenu } from "./WorkspaceQuickLaunchMenu.js";

interface WorkspaceQuickLaunchProps extends WorkspaceQuickLaunchCommonProps {
  hasWorkspaces: boolean;
  actionLoading: boolean;
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

/**
 * The "+ New Workspace" split-button + dropdown (profile picker, plan-mode,
 * skill quick-launches, custom options). Extracted from WorkspacePanel's render.
 *
 * The trigger is this component's own: a pair of text links that render nothing until
 * the panel already has workspaces. The dropdown itself is shared with
 * {@link WorkspaceQuickLaunchMenu}'s other caller, the empty state (#772).
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
        <WorkspaceQuickLaunchMenu
          placement="up"
          availableProfileOptions={availableProfileOptions}
          selectedProfile={selectedProfile}
          onSelectedProfileChange={onSelectedProfileChange}
          availableSkills={availableSkills}
          onQuickLaunch={onQuickLaunch}
          onSkillQuickLaunch={onSkillQuickLaunch}
          onCustomOptions={onCustomOptions}
        />
      )}
    </div>
  );
}
