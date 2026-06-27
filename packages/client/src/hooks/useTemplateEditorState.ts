import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";

/** The Settings → Templates tab's inline-editor field state. The template DATA
 *  itself lives in `useIssueTemplates`; this only owns which row is being edited
 *  and the draft field values. Extracted verbatim from SettingsPanel. */
export interface TemplateEditorState {
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
}

export function useTemplateEditorState(): TemplateEditorState {
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [editTemplateName, setEditTemplateName] = useState("");
  const [editTemplateBody, setEditTemplateBody] = useState("");
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateBody, setNewTemplateBody] = useState("");

  return {
    editingTemplateId, setEditingTemplateId,
    editTemplateName, setEditTemplateName,
    editTemplateBody, setEditTemplateBody,
    newTemplateName, setNewTemplateName,
    newTemplateBody, setNewTemplateBody,
  };
}
