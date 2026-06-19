import { useEffect, useRef, useState } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { apiPatch } from "../lib/api.js";

/**
 * Inline (click-to-edit) title + description editing for IssueDetailPanel,
 * independent of the full edit form. Owns the draft values, busy/error state,
 * input refs, focus-on-open + re-sync-on-issue-change effects, and the
 * optimistic save handlers. The panel destructures these with the same names so
 * its JSX is unchanged.
 */
export function useIssueInlineEdit(
  issue: IssueWithStatus,
  onIssueUpdate: (issue: IssueWithStatus) => void,
  descriptionFetching: boolean,
) {
  const [inlineEditingTitle, setInlineEditingTitle] = useState(false);
  const [inlineTitleValue, setInlineTitleValue] = useState(issue.title);
  const [inlineEditingDescription, setInlineEditingDescription] = useState(false);
  const [inlineDescriptionValue, setInlineDescriptionValue] = useState(issue.description ?? "");
  const [inlineSaving, setInlineSaving] = useState<"title" | "description" | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const inlineTitleRef = useRef<HTMLInputElement>(null);
  const inlineDescriptionRef = useRef<HTMLTextAreaElement>(null);

  // Re-sync drafts when the issue prop changes (unless mid-edit).
  useEffect(() => {
    if (!inlineEditingTitle) setInlineTitleValue(issue.title);
    if (!inlineEditingDescription) setInlineDescriptionValue(issue.description ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue]);

  useEffect(() => {
    if (inlineEditingTitle) inlineTitleRef.current?.focus();
  }, [inlineEditingTitle]);

  useEffect(() => {
    if (inlineEditingDescription) inlineDescriptionRef.current?.focus();
  }, [inlineEditingDescription]);

  async function handleInlineTitleSave() {
    const trimmed = inlineTitleValue.trim();
    if (!trimmed || inlineSaving) return;
    if (trimmed === issue.title) {
      setInlineEditingTitle(false);
      return;
    }
    setInlineSaving("title");
    setInlineError(null);
    const prev = issue.title;
    onIssueUpdate({ ...issue, title: trimmed });
    try {
      await apiPatch(`/api/issues/${issue.id}`, { title: trimmed });
      setInlineEditingTitle(false);
    } catch (err) {
      onIssueUpdate({ ...issue, title: prev });
      setInlineTitleValue(prev);
      setInlineError(err instanceof Error ? err.message : "Failed to save title");
    } finally {
      setInlineSaving(null);
    }
  }

  async function handleInlineDescriptionSave() {
    if (inlineSaving || descriptionFetching) return;
    const value = inlineDescriptionValue.trim();
    const prev = issue.description ?? "";
    if (value === prev) {
      setInlineEditingDescription(false);
      return;
    }
    setInlineSaving("description");
    setInlineError(null);
    onIssueUpdate({ ...issue, description: value || undefined });
    try {
      await apiPatch(`/api/issues/${issue.id}`, { description: value || undefined });
      setInlineEditingDescription(false);
    } catch (err) {
      onIssueUpdate({ ...issue, description: prev || undefined });
      setInlineDescriptionValue(prev);
      setInlineError(err instanceof Error ? err.message : "Failed to save description");
    } finally {
      setInlineSaving(null);
    }
  }

  return {
    inlineEditingTitle, setInlineEditingTitle,
    inlineTitleValue, setInlineTitleValue,
    inlineEditingDescription, setInlineEditingDescription,
    inlineDescriptionValue, setInlineDescriptionValue,
    inlineSaving,
    inlineError, setInlineError,
    inlineTitleRef,
    inlineDescriptionRef,
    handleInlineTitleSave,
    handleInlineDescriptionSave,
  };
}
