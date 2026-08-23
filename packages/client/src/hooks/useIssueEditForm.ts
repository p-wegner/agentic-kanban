import { useRef, useState } from "react";
import type { IssueWithStatus, UpdateIssueRequest } from "@agentic-kanban/shared";
import { apiPost } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { useIssueEnhance } from "./useIssueEnhance.js";
import {
  buildIssueUpdatePayload,
  hasIssueEditChanges,
  issueEditBaseline,
  validateIssueEditFields,
  type IssueEditFields,
} from "../lib/issueEditForm.js";

/**
 * Owns IssueDetailPanel's full edit-form lifecycle: the editable field state,
 * the unsaved-changes flag, and the save / cancel / enhance / AI-estimate
 * handlers. Extracted from the panel so the edit logic is one cohesive,
 * separately-reasoned unit (the panel destructures these with the same names, so
 * its JSX and the prop-sync / keydown effects are unchanged).
 *
 * setSaving is exposed because the panel's delete flow reuses the same busy flag;
 * the other busy/snapshot setters (estimating, and the enhance state now owned by
 * `useIssueEnhance`) stay internal.
 */
export function useIssueEditForm(
  issue: IssueWithStatus,
  onUpdate: (id: string, data: UpdateIssueRequest) => Promise<void>,
) {
  const initial = issueEditBaseline(issue);
  const [editing, setEditing] = useState(false);
  const [descriptionMode, setDescriptionMode] = useState<"edit" | "preview">("edit");
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [pastedImages, setPastedImages] = useState<string[]>([]);
  const [issueType, setIssueType] = useState(initial.issueType);
  const [estimate, setEstimate] = useState<string>(initial.estimate);
  const [dueDate, setDueDate] = useState<string>(initial.dueDate);
  const [externalKey, setExternalKey] = useState<string>(initial.externalKey);
  const [externalUrl, setExternalUrl] = useState<string>(initial.externalUrl);
  const [skipAutoReview, setSkipAutoReview] = useState(initial.skipAutoReview);
  const [saving, setSaving] = useState(false);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const [estimating, setEstimating] = useState(false);
  const [milestoneId, setMilestoneId] = useState<string | null>(initial.milestoneId);

  // The AI-enhance behaviour is one implementation shared with both create-issue forms
  // (#772/#810). `clearSnapshot` is what the edit form needs on top of the create forms:
  // cancelling an edit must drop a pending Undo, see handleCancelEdit.
  const {
    enhancing,
    preEnhanceSnapshot,
    enhance: handleEnhance,
    undoEnhance: handleUndoEnhance,
    clearSnapshot: clearEnhanceSnapshot,
  } = useIssueEnhance({
    projectId: issue.projectId,
    title,
    description,
    setTitle,
    setDescription,
  });

  const fields: IssueEditFields = {
    title, description, issueType, estimate, dueDate,
    externalKey, externalUrl, skipAutoReview, milestoneId,
  };

  // Track unsaved changes for warning (the nine-field comparison lives in lib/, #782)
  const hasChanges = editing && hasIssueEditChanges(fields, issue);

  function handleCancelEdit() {
    if (hasChanges) {
      if (!window.confirm("You have unsaved changes. Discard?")) return;
    }
    setEditing(false);
    setDescriptionMode("edit");
    clearEnhanceSnapshot();
    const baseline = issueEditBaseline(issue);
    setTitle(baseline.title);
    setDescription(baseline.description);
    setIssueType(baseline.issueType);
    setEstimate(baseline.estimate);
    setDueDate(baseline.dueDate);
    setExternalKey(baseline.externalKey);
    setExternalUrl(baseline.externalUrl);
    setSkipAutoReview(baseline.skipAutoReview);
    setMilestoneId(baseline.milestoneId);
  }

  async function handleAiEstimate() {
    if (estimating) return;
    setEstimating(true);
    try {
      const result = await apiPost<{ estimate: string; reasoning: string }>("/api/issues/ai-estimate", { issueId: issue.id });
      await onUpdate(issue.id, { estimate: result.estimate as UpdateIssueRequest["estimate"] });
      showToast(`AI suggested: ${result.estimate}${result.reasoning ? ` — ${result.reasoning}` : ""}`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "AI estimate failed", "error");
    } finally {
      setEstimating(false);
    }
  }

  async function handleSave() {
    if (saving) return;
    const invalid = validateIssueEditFields(fields);
    if (invalid) {
      showToast(invalid, "error");
      return;
    }
    setSaving(true);
    try {
      await onUpdate(issue.id, buildIssueUpdatePayload(fields, pastedImages));
      setPastedImages([]);
      setEditing(false);
      setDescriptionMode("edit");
      // Don't close panel — F1 fix. Parent will re-render with updated data.
    } finally {
      setSaving(false);
    }
  }

  return {
    editing, setEditing,
    descriptionMode, setDescriptionMode,
    title, setTitle,
    description, setDescription,
    pastedImages, setPastedImages,
    issueType, setIssueType,
    estimate, setEstimate,
    dueDate, setDueDate,
    externalKey, setExternalKey,
    externalUrl, setExternalUrl,
    skipAutoReview, setSkipAutoReview,
    milestoneId, setMilestoneId,
    saving, setSaving, enhancing, preEnhanceSnapshot, estimating,
    descriptionRef,
    hasChanges,
    handleCancelEdit, handleEnhance, handleUndoEnhance, handleAiEstimate, handleSave,
  };
}
