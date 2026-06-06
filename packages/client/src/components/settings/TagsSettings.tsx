import type { Dispatch, SetStateAction } from "react";
import { apiFetch } from "../../lib/api.js";
import { showToast } from "../Toast.js";
import type { TagSetting } from "../SettingsPanel.shared.js";

type TagsSettingsProps = {
  tagsList: TagSetting[];
  setTagsList: Dispatch<SetStateAction<TagSetting[]>>;
  editingTag: string | null;
  setEditingTag: Dispatch<SetStateAction<string | null>>;
  editTagName: string;
  setEditTagName: Dispatch<SetStateAction<string>>;
  editTagColor: string;
  setEditTagColor: Dispatch<SetStateAction<string>>;
  newTagName: string;
  setNewTagName: Dispatch<SetStateAction<string>>;
  newTagColor: string;
  setNewTagColor: Dispatch<SetStateAction<string>>;
  selectedTagIds: Set<string>;
  setSelectedTagIds: Dispatch<SetStateAction<Set<string>>>;
  mergeTargetId: string;
  setMergeTargetId: Dispatch<SetStateAction<string>>;
  mergingTags: boolean;
  setMergingTags: Dispatch<SetStateAction<boolean>>;
};

export function TagsSettings({ tagsList, setTagsList, editingTag, setEditingTag, editTagName, setEditTagName, editTagColor, setEditTagColor, newTagName, setNewTagName, newTagColor, setNewTagColor, selectedTagIds, setSelectedTagIds, mergeTargetId, setMergeTargetId, mergingTags, setMergingTags }: TagsSettingsProps) {
  return (
<div className="space-y-4">
                  <p className="text-xs text-gray-500">
                    Manage tags used to categorize issues. You can rename, delete, or merge tags together.
                    Merging moves all issues from the selected tags onto the target tag, then removes the merged tags.
                  </p>

                  {/* Tag list */}
                  <div className="space-y-2">
                    {tagsList.map((tag) => (
                      <div key={tag.id} className="flex items-center gap-2 border border-gray-200 rounded-md px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selectedTagIds.has(tag.id)}
                          disabled={tag.isBuiltin}
                          onChange={(e) => {
                            const next = new Set(selectedTagIds);
                            if (e.target.checked) next.add(tag.id);
                            else next.delete(tag.id);
                            setSelectedTagIds(next);
                          }}
                          className="rounded border-gray-300 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                        />
                        <span
                          className="w-3 h-3 rounded-full shrink-0"
                          style={{ backgroundColor: tag.color ?? "#6B7280" }}
                        />
                        {editingTag === tag.id ? (
                          <div className="flex items-center gap-2 flex-1">
                            <input
                              type="text"
                              value={editTagName}
                              onChange={(e) => setEditTagName(e.target.value)}
                              className="flex-1 text-sm border border-gray-300 rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
                              autoFocus
                            />
                            <input
                              type="color"
                              value={editTagColor || "#6B7280"}
                              onChange={(e) => setEditTagColor(e.target.value)}
                              className="w-7 h-7 rounded border border-gray-300 cursor-pointer p-0.5"
                            />
                            <button
                              onClick={async () => {
                                if (!editTagName.trim()) return;
                                try {
                                  await apiFetch(`/api/tags/${tag.id}`, {
                                    method: "PATCH",
                                    body: JSON.stringify({ name: editTagName.trim(), color: editTagColor || null }),
                                  });
                                  setTagsList((t) => t.map((tg) => tg.id === tag.id ? { ...tg, name: editTagName.trim(), color: editTagColor || null } : tg));
                                  setEditingTag(null);
                                  showToast("Tag updated", "success");
                                } catch {
                                  showToast("Failed to update tag", "error");
                                }
                              }}
                              className="text-xs px-2 py-1 bg-brand-600 text-white rounded hover:bg-brand-700"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditingTag(null)}
                              className="text-xs px-2 py-1 text-gray-600 hover:bg-gray-100 rounded"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <>
                            <span className="flex-1 text-sm text-gray-800">{tag.name}</span>
                            {tag.isBuiltin && (
                              <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded border border-gray-200 font-medium">
                                built-in
                              </span>
                            )}
                            {!tag.isBuiltin && (
                              <>
                                <button
                                  onClick={() => { setEditingTag(tag.id); setEditTagName(tag.name); setEditTagColor(tag.color ?? "#6B7280"); }}
                                  className="text-xs text-gray-400 hover:text-brand-600"
                                >
                                  Rename
                                </button>
                                <button
                                  onClick={async () => {
                                    if (!confirm(`Delete tag "${tag.name}"? This will remove it from all issues.`)) return;
                                    try {
                                      await apiFetch(`/api/tags/${tag.id}`, { method: "DELETE" });
                                      setTagsList((t) => t.filter((tg) => tg.id !== tag.id));
                                      setSelectedTagIds((s) => { const n = new Set(s); n.delete(tag.id); return n; });
                                      showToast("Tag deleted", "success");
                                    } catch {
                                      showToast("Failed to delete tag", "error");
                                    }
                                  }}
                                  className="text-xs text-gray-400 hover:text-red-600"
                                >
                                  Delete
                                </button>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Merge section */}
                  {selectedTagIds.size >= 2 && (
                    <div className="border border-amber-200 bg-amber-50 rounded-md p-3 space-y-2">
                      <p className="text-xs font-medium text-amber-800">
                        Merge {selectedTagIds.size} selected tags into one
                      </p>
                      <p className="text-xs text-amber-700">
                        All issues from the merged tags will be re-tagged with the target tag. The other tags will be deleted.
                      </p>
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-amber-800 whitespace-nowrap">Merge into:</label>
                        <select
                          value={mergeTargetId}
                          onChange={(e) => setMergeTargetId(e.target.value)}
                          className="flex-1 text-sm border border-amber-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-white"
                        >
                          <option value="">Select target tag…</option>
                          {tagsList.filter((t) => selectedTagIds.has(t.id)).map((t) => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </select>
                        <button
                          disabled={!mergeTargetId || mergingTags}
                          onClick={async () => {
                            if (!mergeTargetId) return;
                            const sourceIds = [...selectedTagIds].filter((id) => id !== mergeTargetId);
                            setMergingTags(true);
                            try {
                              await apiFetch("/api/tags/merge", {
                                method: "POST",
                                body: JSON.stringify({ targetId: mergeTargetId, sourceIds }),
                              });
                              setTagsList((t) => t.filter((tg) => tg.id === mergeTargetId || !selectedTagIds.has(tg.id)));
                              setSelectedTagIds(new Set());
                              setMergeTargetId("");
                              showToast("Tags merged", "success");
                            } catch {
                              showToast("Merge failed", "error");
                            } finally {
                              setMergingTags(false);
                            }
                          }}
                          className="text-xs px-3 py-1.5 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
                        >
                          {mergingTags ? "Merging…" : "Merge"}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* New tag form */}
                  <div className="border-t border-gray-100 pt-3 space-y-2">
                    <p className="text-xs font-medium text-gray-600">Add new tag</p>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={newTagColor}
                        onChange={(e) => setNewTagColor(e.target.value)}
                        className="w-7 h-7 rounded border border-gray-300 cursor-pointer p-0.5 shrink-0"
                      />
                      <input
                        type="text"
                        value={newTagName}
                        onChange={(e) => setNewTagName(e.target.value)}
                        placeholder="Tag name"
                        className="flex-1 text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
                        onKeyDown={async (e) => {
                          if (e.key === "Enter" && newTagName.trim()) {
                            try {
                              const created = await apiFetch<{ id: string; name: string; color: string | null }>("/api/tags", {
                                method: "POST",
                                body: JSON.stringify({ name: newTagName.trim(), color: newTagColor }),
                              });
                              setTagsList((t) => [...t, { ...created, isBuiltin: false }]);
                              setNewTagName("");
                              setNewTagColor("#6B7280");
                              showToast("Tag created", "success");
                            } catch {
                              showToast("Failed to create tag", "error");
                            }
                          }
                        }}
                      />
                      <button
                        disabled={!newTagName.trim()}
                        onClick={async () => {
                          if (!newTagName.trim()) return;
                          try {
                            const created = await apiFetch<{ id: string; name: string; color: string | null }>("/api/tags", {
                              method: "POST",
                              body: JSON.stringify({ name: newTagName.trim(), color: newTagColor }),
                            });
                            setTagsList((t) => [...t, { ...created, isBuiltin: false }]);
                            setNewTagName("");
                            setNewTagColor("#6B7280");
                            showToast("Tag created", "success");
                          } catch {
                            showToast("Failed to create tag", "error");
                          }
                        }}
                        className="text-xs px-3 py-1.5 bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50"
                      >
                        Add
                      </button>
                    </div>
                  </div>
                </div>
  );
}
