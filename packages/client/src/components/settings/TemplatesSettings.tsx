import type { Dispatch, SetStateAction } from "react";
import type { IssueTemplate } from "../../hooks/useIssueTemplates.js";
import { showToast } from "../Toast.js";

type TemplatesSettingsProps = {
  customTemplates: IssueTemplate[];
  allIssueTemplates: IssueTemplate[];
  MAX_TEMPLATES: number;
  addTemplate: (template: { name: string; body: string }) => Promise<void>;
  updateTemplate: (id: string, updates: { name: string; body: string }) => Promise<void>;
  removeTemplate: (id: string) => Promise<void>;
  editingTemplateId: string | null;
  setEditingTemplateId: Dispatch<SetStateAction<string | null>>;
  editTemplateName: string;
  setEditTemplateName: Dispatch<SetStateAction<string>>;
  editTemplateBody: string;
  setEditTemplateBody: Dispatch<SetStateAction<string>>;
  newTemplateName: string;
  setNewTemplateName: Dispatch<SetStateAction<string>>;
  newTemplateBody: string;
  setNewTemplateBody: Dispatch<SetStateAction<string>>;
};

export function TemplatesSettings({ customTemplates, allIssueTemplates, MAX_TEMPLATES, addTemplate, updateTemplate, removeTemplate, editingTemplateId, setEditingTemplateId, editTemplateName, setEditTemplateName, editTemplateBody, setEditTemplateBody, newTemplateName, setNewTemplateName, newTemplateBody, setNewTemplateBody }: TemplatesSettingsProps) {
  return (
<div className="space-y-4">
                  <p className="text-xs text-gray-500">
                    Reusable description templates for faster ticket creation. Built-in templates cannot be edited;
                    add your own below (max {MAX_TEMPLATES}).
                  </p>

                  {/* All templates list */}
                  <div className="space-y-2">
                    {allIssueTemplates.map((tpl) => {
                      const isBuiltin = tpl.id.startsWith("builtin-");
                      return (
                        <div key={tpl.id} className="border border-gray-200 dark:border-gray-700 rounded-md p-3 space-y-2">
                          {editingTemplateId === tpl.id ? (
                            <div className="space-y-2">
                              <input
                                type="text"
                                value={editTemplateName}
                                onChange={(e) => setEditTemplateName(e.target.value)}
                                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
                                placeholder="Template name"
                                autoFocus
                              />
                              <textarea
                                value={editTemplateBody}
                                onChange={(e) => setEditTemplateBody(e.target.value)}
                                rows={6}
                                className="w-full text-xs font-mono border border-gray-300 dark:border-gray-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100 resize-y"
                                placeholder="Template body (Markdown)"
                              />
                              <div className="flex gap-2">
                                <button
                                  onClick={async () => {
                                    if (!editTemplateName.trim()) return;
                                    try {
                                      await updateTemplate(tpl.id, { name: editTemplateName.trim(), body: editTemplateBody });
                                      setEditingTemplateId(null);
                                      showToast("Template updated", "success");
                                    } catch (e) {
                                      showToast(e instanceof Error ? e.message : "Failed to update template", "error");
                                    }
                                  }}
                                  className="text-xs bg-brand-600 text-white px-3 py-1 rounded hover:bg-brand-700 disabled:opacity-50"
                                  disabled={!editTemplateName.trim()}
                                >
                                  Save
                                </button>
                                <button
                                  onClick={() => setEditingTemplateId(null)}
                                  className="text-xs text-gray-500 dark:text-gray-400 px-3 py-1 hover:text-gray-700 dark:hover:text-gray-200"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex-1 min-w-0">
                                <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{tpl.name}</span>
                                {isBuiltin && (
                                  <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">(built-in)</span>
                                )}
                                <p className="text-xs text-gray-400 dark:text-gray-500 truncate mt-0.5">{tpl.body.slice(0, 80)}{tpl.body.length > 80 ? "…" : ""}</p>
                              </div>
                              {!isBuiltin && (
                                <div className="flex items-center gap-1 shrink-0">
                                  <button
                                    onClick={() => {
                                      setEditingTemplateId(tpl.id);
                                      setEditTemplateName(tpl.name);
                                      setEditTemplateBody(tpl.body);
                                    }}
                                    className="text-xs text-brand-600 dark:text-brand-400 px-2 py-1 hover:text-brand-800 dark:hover:text-brand-200"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    onClick={async () => {
                                      if (!window.confirm(`Delete template "${tpl.name}"?`)) return;
                                      try {
                                        await removeTemplate(tpl.id);
                                        showToast("Template deleted", "success");
                                      } catch {
                                        showToast("Failed to delete template", "error");
                                      }
                                    }}
                                    className="text-xs text-red-500 dark:text-red-400 px-2 py-1 hover:text-red-700 dark:hover:text-red-300"
                                  >
                                    Delete
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Add new template */}
                  {customTemplates.length < MAX_TEMPLATES && (
                    <div className="border border-dashed border-gray-300 dark:border-gray-600 rounded-md p-3 space-y-2">
                      <p className="text-xs font-medium text-gray-600 dark:text-gray-400">Add custom template</p>
                      <input
                        type="text"
                        value={newTemplateName}
                        onChange={(e) => setNewTemplateName(e.target.value)}
                        placeholder="Template name"
                        className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
                      />
                      <textarea
                        value={newTemplateBody}
                        onChange={(e) => setNewTemplateBody(e.target.value)}
                        rows={4}
                        placeholder="Template body (Markdown)"
                        className="w-full text-xs font-mono border border-gray-300 dark:border-gray-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100 resize-y"
                      />
                      <button
                        onClick={async () => {
                          if (!newTemplateName.trim()) return;
                          try {
                            await addTemplate({ name: newTemplateName.trim(), body: newTemplateBody });
                            setNewTemplateName("");
                            setNewTemplateBody("");
                            showToast("Template added", "success");
                          } catch (e) {
                            showToast(e instanceof Error ? e.message : "Failed to add template", "error");
                          }
                        }}
                        disabled={!newTemplateName.trim()}
                        className="text-xs bg-brand-600 text-white px-3 py-1 rounded hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Add Template
                      </button>
                    </div>
                  )}
                  {customTemplates.length >= MAX_TEMPLATES && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">Maximum of {MAX_TEMPLATES} custom templates reached.</p>
                  )}
                </div>
  );
}
