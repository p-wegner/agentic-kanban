import type { Dispatch, SetStateAction } from "react";
import { apiFetch } from "../../lib/api.js";
import { EditSkillForm, type SkillSetting } from "../SettingsPanel.shared.js";
import { showToast } from "../Toast.js";

type NewSkill = { name: string; description: string; prompt: string; model: string };

type SkillsSettingsProps = {
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
};

export function SkillsSettings({ skills, setSkills, editingSkill, setEditingSkill, newSkill, setNewSkill, installedSkills, setInstalledSkills, installingSkill, setInstallingSkill }: SkillsSettingsProps) {
  return (
<div className="space-y-3">
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Agent skills are prompt templates injected into the agent's context when launching a workspace. They teach the agent how to interact with the board and perform specific tasks. Skills can be global or scoped to a specific project.
                  </p>
                  {skills.map((skill) => (
                    <div key={skill.id} className="border border-gray-200 dark:border-gray-700 rounded-md p-3">
                      {editingSkill === skill.id ? (
                        <EditSkillForm
                          skill={skill}
                          onSave={async (updates) => {
                            await apiFetch(`/api/agent-skills/${skill.id}`, {
                              method: "PUT",
                              body: JSON.stringify(updates),
                            });
                            setSkills((s) => s.map((sk) => sk.id === skill.id ? { ...sk, ...updates } : sk));
                            setEditingSkill(null);
                          }}
                          onCancel={() => setEditingSkill(null)}
                        />
                      ) : (
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-900">{skill.name}</span>
                              {skill.isBuiltin && (
                                <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded">builtin</span>
                              )}
                              {skill.projectId ? (
                                <span className="text-[10px] px-1.5 py-0.5 bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300 rounded">project</span>
                              ) : (
                                <span className="text-[10px] px-1.5 py-0.5 bg-green-50 text-green-600 rounded">global</span>
                              )}
                              {skill.model && (
                                <span className="text-[10px] px-1.5 py-0.5 bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300 rounded">{skill.model}</span>
                              )}
                            </div>
                            <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{skill.description}</p>
                          </div>
                          <div className="flex gap-1 shrink-0">
                            <button
                              onClick={() => setEditingSkill(skill.id)}
                              className="text-xs text-gray-400 hover:text-brand-600 px-1"
                            >
                              Edit
                            </button>
                            <button
                              title={installedSkills[skill.id] ? "Re-install to project (.claude/skills/)" : "Install to project (.claude/skills/)"}
                              disabled={installingSkill === skill.id}
                              onClick={async () => {
                                setInstallingSkill(skill.id);
                                try {
                                  await apiFetch(`/api/agent-skills/${skill.id}/install`, { method: "POST" });
                                  setInstalledSkills((s) => ({ ...s, [skill.id]: true }));
                                  showToast(`Installed "${skill.name}" to .claude/skills/`, "success");
                                } catch {
                                  showToast("Install failed", "error");
                                } finally {
                                  setInstallingSkill(null);
                                }
                              }}
                              className={`text-xs px-1 ${installedSkills[skill.id] ? "text-green-600 hover:text-green-700" : "text-gray-400 hover:text-green-600"}`}
                            >
                              {installingSkill === skill.id ? "…" : installedSkills[skill.id] ? "✓ installed" : "Install"}
                            </button>
                            {!skill.isBuiltin && (
                              <button
                                onClick={async () => {
                                  await apiFetch(`/api/agent-skills/${skill.id}`, { method: "DELETE" });
                                  setSkills((s) => s.filter((sk) => sk.id !== skill.id));
                                }}
                                className="text-xs text-gray-400 hover:text-red-600 px-1"
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                  {newSkill ? (
                    <div className="border border-gray-200 rounded-md p-3">
                      <EditSkillForm
                        skill={{ name: newSkill.name, description: newSkill.description, prompt: newSkill.prompt, model: newSkill.model || null, projectId: null }}
                        isNew
                        onSave={async (data) => {
                          const created = await apiFetch<{ id: string }>("/api/agent-skills", {
                            method: "POST",
                            body: JSON.stringify(data),
                          });
                          setSkills((s) => [...s, { ...data, id: created.id, isBuiltin: false, projectId: null }]);
                          setNewSkill(null);
                        }}
                        onCancel={() => setNewSkill(null)}
                      />
                    </div>
                  ) : (
                    <button
                      onClick={() => setNewSkill({ name: "", description: "", prompt: "", model: "" })}
                      className="text-sm text-brand-600 hover:text-brand-700"
                    >
                      + Add Skill
                    </button>
                  )}
                </div>
  );
}
