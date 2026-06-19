import { useRef, useState } from "react";
import type { IssueWithStatus, UpdateIssueRequest } from "@agentic-kanban/shared";
import { apiPost } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { isHttpUrl } from "../lib/url.js";

/**
 * Owns IssueDetailPanel's full edit-form lifecycle: the editable field state,
 * the unsaved-changes flag, and the save / cancel / enhance / AI-estimate
 * handlers. Extracted from the panel so the edit logic is one cohesive,
 * separately-reasoned unit (the panel destructures these with the same names, so
 * its JSX and the prop-sync / keydown effects are unchanged).
 *
 * setSaving is exposed because the panel's delete flow reuses the same busy flag;
 * the other busy/snapshot setters (enhancing/estimating/preEnhance) stay internal.
 */
export function useIssueEditForm(
  issue: IssueWithStatus,
  onUpdate: (id: string, data: UpdateIssueRequest) => Promise<void>,
) {
  const [editing, setEditing] = useState(false);
  const [descriptionMode, setDescriptionMode] = useState<"edit" | "preview">("edit");
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.description ?? "");
  const [pastedImages, setPastedImages] = useState<string[]>([]);
  const [issueType, setIssueType] = useState(issue.issueType ?? "task");
  const [estimate, setEstimate] = useState<string>(issue.estimate ?? "");
  const [dueDate, setDueDate] = useState<string>(issue.dueDate ?? "");
  const [externalKey, setExternalKey] = useState<string>(issue.externalKey ?? "");
  const [externalUrl, setExternalUrl] = useState<string>(issue.externalUrl ?? "");
  const [skipAutoReview, setSkipAutoReview] = useState(issue.skipAutoReview ?? false);
  const [saving, setSaving] = useState(false);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [preEnhanceSnapshot, setPreEnhanceSnapshot] = useState<{ title: string; description: string } | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [milestoneId, setMilestoneId] = useState<string | null>(issue.milestoneId ?? null);

  // Track unsaved changes for warning
  const hasChanges = editing && (
    title !== issue.title ||
    description !== (issue.description ?? "") ||
    issueType !== (issue.issueType ?? "task") ||
    estimate !== (issue.estimate ?? "") ||
    dueDate !== (issue.dueDate ?? "") ||
    externalKey !== (issue.externalKey ?? "") ||
    externalUrl !== (issue.externalUrl ?? "") ||
    skipAutoReview !== (issue.skipAutoReview ?? false) ||
    milestoneId !== (issue.milestoneId ?? null)
  );

  function handleCancelEdit() {
    if (hasChanges) {
      if (!window.confirm("You have unsaved changes. Discard?")) return;
    }
    setEditing(false);
    setDescriptionMode("edit");
    setPreEnhanceSnapshot(null);
    setTitle(issue.title);
    setDescription(issue.description ?? "");
    setIssueType(issue.issueType ?? "task");
    setEstimate(issue.estimate ?? "");
    setDueDate(issue.dueDate ?? "");
    setExternalKey(issue.externalKey ?? "");
    setExternalUrl(issue.externalUrl ?? "");
    setSkipAutoReview(issue.skipAutoReview ?? false);
    setMilestoneId(issue.milestoneId ?? null);
  }

  async function handleEnhance() {
    if (!title.trim() || enhancing) return;
    setEnhancing(true);
    try {
      setPreEnhanceSnapshot({ title, description });
      const result = await apiPost<{ title: string; description: string }>("/api/issues/enhance", { title, description, projectId: issue.projectId });
      setTitle(result.title);
      setDescription(result.description);
    } catch (err) {
      setPreEnhanceSnapshot(null);
      showToast(err instanceof Error ? err.message : "Enhancement failed", "error");
    } finally {
      setEnhancing(false);
    }
  }

  function handleUndoEnhance() {
    if (!preEnhanceSnapshot) return;
    setTitle(preEnhanceSnapshot.title);
    setDescription(preEnhanceSnapshot.description);
    setPreEnhanceSnapshot(null);
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
    const trimmedUrl = externalUrl.trim();
    if (trimmedUrl && !isHttpUrl(trimmedUrl)) {
      showToast("External URL must start with http:// or https://", "error");
      return;
    }
    setSaving(true);
    try {
      const imageMarkdown = pastedImages.map((url, i) => `![screenshot-${i + 1}](${url})`).join("\n");
      const fullDescription = [description.trim(), imageMarkdown].filter(Boolean).join("\n\n");
      await onUpdate(issue.id, {
        title: title.trim(),
        description: fullDescription || undefined,
        issueType: issueType as UpdateIssueRequest["issueType"],
        estimate: (estimate || null) as UpdateIssueRequest["estimate"],
        skipAutoReview,
        dueDate: dueDate || null,
        externalKey: externalKey.trim() || null,
        externalUrl: trimmedUrl || null,
        milestoneId: milestoneId || null,
      });
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
