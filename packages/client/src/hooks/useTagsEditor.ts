import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { TagSetting } from "../components/SettingsPanel.shared.js";

/** Return shape matches `TagsSettingsProps` exactly so the panel can spread it
 *  straight into `<TagsSettings {...} />`. */
export interface TagsEditor {
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
}

/** Owns the Settings → Tags tab's local editing state (the list, the rename
 *  fields, the multi-select + merge-target). Extracted verbatim from
 *  SettingsPanel: `tagsList` is hydrated by the settings bootstrap via the
 *  exposed `setTagsList`; everything else is self-contained. */
export function useTagsEditor(): TagsEditor {
  const [tagsList, setTagsList] = useState<TagSetting[]>([]);
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editTagName, setEditTagName] = useState("");
  const [editTagColor, setEditTagColor] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#6B7280");
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [mergeTargetId, setMergeTargetId] = useState<string>("");
  const [mergingTags, setMergingTags] = useState(false);

  return {
    tagsList, setTagsList,
    editingTag, setEditingTag,
    editTagName, setEditTagName,
    editTagColor, setEditTagColor,
    newTagName, setNewTagName,
    newTagColor, setNewTagColor,
    selectedTagIds, setSelectedTagIds,
    mergeTargetId, setMergeTargetId,
    mergingTags, setMergingTags,
  };
}
