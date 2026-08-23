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

/** Model picker for the menu. Omitted entirely by the compact variant, which has none. */
export interface QuickLaunchModelPicker {
  selectedModel: string;
  onSelectedModelChange: (value: string) => void;
  /** Which option list to offer — Codex and Claude publish different model ids. */
  isCodex: boolean;
}

/**
 * Everything a quick-launch trigger has to forward to the menu, declared once. Both
 * shells took the same ten props and passed them straight through; the two lists had
 * already drifted apart in ordering before they were collapsed (#772).
 */
export interface WorkspaceQuickLaunchCommonProps {
  availableProfileOptions: ProfileOption[];
  selectedProfile: string;
  onSelectedProfileChange: (value: string) => void;
  availableSkills: AvailableSkill[];
  onQuickLaunch: (planMode: boolean) => void;
  onSkillQuickLaunch: (skillId: string) => void;
  onCustomOptions: () => void;
}

interface WorkspaceQuickLaunchMenuProps extends WorkspaceQuickLaunchCommonProps {
  /** "up" opens above the trigger (the in-panel link), "down" below (the empty state). */
  placement: "up" | "down";
  model?: QuickLaunchModelPicker | null;
}

const SECTION_SELECT_CLASS = "w-full text-sm border border-gray-200 dark:border-gray-700 rounded px-2 py-1";
const MENU_ITEM_CLASS = "w-full text-left text-sm px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800";

function Divider() {
  return <div className="border-t border-gray-100 dark:border-gray-800" />;
}

/** A labelled picker at the top of the menu, followed by its divider. */
function MenuSelectSection({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="px-3 py-1.5">
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{label}</label>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={SECTION_SELECT_CLASS}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </select>
      </div>
      <Divider />
    </>
  );
}

/**
 * The quick-launch dropdown body: optional profile and model pickers, the two
 * New-Workspace entries, the skill quick-launches, and "Custom options...".
 *
 * #772 — `WorkspaceQuickLaunch` and `WorkspaceEmptyState` carried this list twice,
 * byte-identical apart from the model section and which way the menu opens. The two
 * TRIGGERS stay separate components: one is a pair of text links that renders nothing
 * until workspaces exist, the other is the empty state's solid call-to-action with its
 * own "Creating..." label. That difference is deliberate, so only the menu is shared.
 */
export function WorkspaceQuickLaunchMenu({
  placement,
  availableProfileOptions,
  selectedProfile,
  onSelectedProfileChange,
  model,
  availableSkills,
  onQuickLaunch,
  onSkillQuickLaunch,
  onCustomOptions,
}: WorkspaceQuickLaunchMenuProps) {
  return (
    <div
      className={`absolute ${placement === "up" ? "bottom-full mb-1" : "top-full mt-1"} left-0 w-52 bg-surface-raised dark:bg-surface-raised-dark border border-gray-200 dark:border-gray-700 rounded shadow-lg z-10`}
    >
      {availableProfileOptions.length > 0 && (
        <MenuSelectSection label="Profile" value={selectedProfile} onChange={onSelectedProfileChange}>
          <option value="">Default</option>
          {availableProfileOptions.map((option) => (
            <option key={profileOptionValue(option)} value={profileOptionValue(option)}>
              {providerLabel(option.provider)}: {(option.provider === "copilot" && option.name === COPILOT_DEFAULT_PROFILE) || (option.provider === "codex" && option.name === CODEX_DEFAULT_PROFILE) ? "Default" : option.name}
            </option>
          ))}
        </MenuSelectSection>
      )}
      {model && (
        <MenuSelectSection label="Model" value={model.selectedModel} onChange={model.onSelectedModelChange}>
          {(model.isCodex ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS).map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </MenuSelectSection>
      )}
      <button onClick={() => onQuickLaunch(false)} className={MENU_ITEM_CLASS}>
        New Workspace
      </button>
      <button onClick={() => onQuickLaunch(true)} className={MENU_ITEM_CLASS}>
        New Workspace with Plan Mode
      </button>
      {availableSkills.length > 0 && (
        <>
          <Divider />
          <div className="px-3 py-1 text-[10px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">Skills</div>
          {availableSkills.map((skill) => (
            <button
              key={skill.id}
              onClick={() => onSkillQuickLaunch(skill.id)}
              className={`${MENU_ITEM_CLASS} flex items-center gap-2`}
              title={skill.description}
            >
              <span className="text-brand-600 dark:text-brand-400">✨</span>
              {humanizeSkillName(skill.name)}
            </button>
          ))}
        </>
      )}
      <Divider />
      <button
        onClick={onCustomOptions}
        className={`${MENU_ITEM_CLASS} text-gray-500 dark:text-gray-400`}
      >
        Custom options...
      </button>
    </div>
  );
}
