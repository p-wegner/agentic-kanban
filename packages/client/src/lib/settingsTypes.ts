/**
 * DTO shapes for the settings surface (#610).
 *
 * Declared in `components/SettingsPanel.shared.tsx` and imported UPWARD by
 * `hooks/useSkillsManager.ts` and `hooks/useTagsEditor.ts` — the hooks that own the data
 * the panel renders. `SettingsPanel.shared` re-exports them, so its importers are unchanged.
 */

export type SkillSetting = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  model: string | null;
  projectId: string | null;
  isBuiltin: boolean;
  isInit?: boolean;
};

export type TagSetting = { id: string; name: string; color: string | null; isBuiltin: boolean };
