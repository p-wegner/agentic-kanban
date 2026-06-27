import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { SkillSetting } from "../components/SettingsPanel.shared.js";

type NewSkill = { name: string; description: string; prompt: string; model: string };

/** Return shape matches `SkillsSettingsProps` exactly so the panel can spread it
 *  into `<SkillsSettings {...} />`. `skills` is also read by the Workflow and
 *  Project tabs; `skills`/`installedSkills` are hydrated by the settings
 *  bootstrap + the deferred install-status batch via the exposed setters. */
export interface SkillsManager {
  skills: SkillSetting[];
  setSkills: Dispatch<SetStateAction<SkillSetting[]>>;
  editingSkill: string | null;
  setEditingSkill: Dispatch<SetStateAction<string | null>>;
  newSkill: NewSkill | null;
  setNewSkill: Dispatch<SetStateAction<NewSkill | null>>;
  installedSkills: Record<string, boolean>;
  setInstalledSkills: Dispatch<SetStateAction<Record<string, boolean>>>;
  installingSkill: string | null;
  setInstallingSkill: Dispatch<SetStateAction<string | null>>;
}

/** Owns the Settings → Skills tab's editing + install state. Extracted verbatim
 *  from SettingsPanel. */
export function useSkillsManager(): SkillsManager {
  const [skills, setSkills] = useState<SkillSetting[]>([]);
  const [editingSkill, setEditingSkill] = useState<string | null>(null);
  const [newSkill, setNewSkill] = useState<NewSkill | null>(null);
  const [installedSkills, setInstalledSkills] = useState<Record<string, boolean>>({});
  const [installingSkill, setInstallingSkill] = useState<string | null>(null);

  return {
    skills, setSkills,
    editingSkill, setEditingSkill,
    newSkill, setNewSkill,
    installedSkills, setInstalledSkills,
    installingSkill, setInstallingSkill,
  };
}
