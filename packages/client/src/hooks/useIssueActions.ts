// Issue-action handlers extracted from IssueDetailPanel (estimate, pin, duplicate,
// artifact copy/open/delete, notes, status-change, delete). Behaviour-preserving:
// handler bodies are a verbatim move; the panel destructures them with the same
// names so its render + child props are unchanged.
import { apiFetch, apiPost, apiPatch, apiDelete } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { issueArtifactKind } from "../lib/artifact-classifiers.js";
import { invalidateAvailableIssuesCache } from "./useIssueDetailData.js";
import type { Dispatch, SetStateAction } from "react";
import type { IssueArtifact, IssueWithStatus, DependencyInfo, UpdateIssueRequest } from "@agentic-kanban/shared";
import type { IssueComment } from "../components/IssueDetailComments.js";
import type { TouchedFile } from "../components/IssueTouchedFilesSection.js";
import type { MoveToDonePending, DependencyImpactPending } from "../components/IssueDetailDialogs.js";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Tag = { id: string; name: string; color: string | null };

interface IssueActionsDeps {
  issue: IssueWithStatus;
  statuses: { id: string; name: string }[];
  dependencies: DependencyInfo;
  allTags: Tag[];
  issueTags: Tag[];
  description: string;
  confirmDelete: boolean;
  duplicating: boolean;
  submittingNote: boolean;
  togglingVisualVerify: boolean;
  deletingArtifactId: string | null;
  deletingCommentId: string | null;
  newNoteBody: string;
  onUpdate: (id: string, data: UpdateIssueRequest) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onNavigateToIssue?: (issueId: string) => void;
  copyIssueArtifactContent: (artifact: IssueArtifact) => Promise<boolean>;
  openIssueArtifact: (artifact: IssueArtifact) => boolean;
  setAllTags: Setter<Tag[]>;
  setArtifacts: Setter<IssueArtifact[]>;
  setComments: Setter<IssueComment[]>;
  setConfirmDelete: Setter<boolean>;
  setDeletingArtifactId: Setter<string | null>;
  setDeletingCommentId: Setter<string | null>;
  setDependencyImpactPending: Setter<DependencyImpactPending | null>;
  setDescription: Setter<string>;
  setDuplicating: Setter<boolean>;
  setEditing: Setter<boolean>;
  setExpandedArtifactId: Setter<string | null>;
  setIssueTags: Setter<Tag[]>;
  setMoveToDonePending: Setter<MoveToDonePending | null>;
  setNewNoteBody: Setter<string>;
  setSaving: Setter<boolean>;
  setSubmittingNote: Setter<boolean>;
  setTogglingVisualVerify: Setter<boolean>;
}

export function useIssueActions(deps: IssueActionsDeps) {
  const {
    issue, statuses, dependencies, allTags, issueTags, description, confirmDelete,
    duplicating, submittingNote, togglingVisualVerify, deletingArtifactId,
    deletingCommentId, newNoteBody, onUpdate, onDelete, onNavigateToIssue,
    copyIssueArtifactContent, openIssueArtifact,
    setAllTags, setArtifacts, setComments, setConfirmDelete, setDeletingArtifactId,
    setDeletingCommentId, setDependencyImpactPending, setDescription, setDuplicating,
    setEditing, setExpandedArtifactId, setIssueTags, setMoveToDonePending,
    setNewNoteBody, setSaving, setSubmittingNote, setTogglingVisualVerify,
  } = deps;
  async function handleQuickEstimate(value: string) {
    const newEstimate = (value === issue.estimate ? null : value) as UpdateIssueRequest["estimate"];
    await onUpdate(issue.id, { estimate: newEstimate });
  }

  async function handleTogglePinned() {
    await onUpdate(issue.id, { pinned: !issue.pinned });
  }

  async function handleDuplicate() {
    if (duplicating) return;
    setDuplicating(true);
    try {
      const result = await apiPost<{ id: string; issueNumber: number; title: string }>(`/api/issues/${issue.id}/duplicate`);
      invalidateAvailableIssuesCache(issue.projectId);
      showToast(`Duplicated as #${result.issueNumber}`, "success");
      onNavigateToIssue?.(result.id);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Duplicate failed", "error");
    } finally {
      setDuplicating(false);
    }
  }

  function handleAppendTouchedFilesToDescription(touchedFiles: TouchedFile[]) {
    if (touchedFiles.length === 0) return;
    const section = "\n\n## Files touched\n" + touchedFiles.map(f => `- ${f.path}`).join("\n");
    const newDescription = (description || "") + section;
    setDescription(newDescription);
    setEditing(true);
    showToast("Appended to description — save to persist");
  }

  async function handleCopyArtifact(artifact: IssueArtifact) {
    try {
      const copied = await copyIssueArtifactContent(artifact);
      if (!copied) throw new Error("Clipboard API unavailable");
      showToast("Artifact copied", "success");
    } catch {
      window.prompt("Copy artifact", artifact.content);
    }
  }

  function handleOpenArtifact(artifact: IssueArtifact) {
    if (artifact.type === "text") {
      setExpandedArtifactId((current) => current === artifact.id ? null : artifact.id);
      return;
    }
    if (!openIssueArtifact(artifact)) {
      setExpandedArtifactId((current) => current === artifact.id ? null : artifact.id);
    }
  }

  async function handleDeleteArtifact(artifact: IssueArtifact) {
    if (deletingArtifactId) return;
    if (!window.confirm(`Delete artifact "${issueArtifactKind(artifact)}"? This cannot be undone.`)) return;
    setDeletingArtifactId(artifact.id);
    try {
      await apiDelete(`/api/issues/${issue.id}/artifacts/${artifact.id}`);
      setArtifacts((prev) => prev.filter((item) => item.id !== artifact.id));
      setExpandedArtifactId((current) => current === artifact.id ? null : current);
      showToast("Artifact deleted", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to delete artifact", "error");
    } finally {
      setDeletingArtifactId(null);
    }
  }

  async function handleAddNote() {
    const body = newNoteBody.trim();
    if (!body || submittingNote) return;
    const optimisticId = `optimistic-${Date.now()}`;
    const optimistic: IssueComment = {
      id: optimisticId,
      issueId: issue.id,
      workspaceId: null,
      kind: "note",
      author: "user",
      body,
      payload: null,
      createdAt: new Date().toISOString(),
    };
    setComments((prev) => [...prev, optimistic]);
    setNewNoteBody("");
    setSubmittingNote(true);
    try {
      const created = await apiPost<IssueComment>(`/api/issues/${issue.id}/comments`, { body, kind: "note", author: "user" });
      setComments((prev) => prev.map((c) => c.id === optimisticId ? created : c));
    } catch (err) {
      setComments((prev) => prev.filter((c) => c.id !== optimisticId));
      setNewNoteBody(body);
      showToast(err instanceof Error ? err.message : "Failed to add comment", "error");
    } finally {
      setSubmittingNote(false);
    }
  }

  async function handleDeleteComment(commentId: string) {
    if (deletingCommentId) return;
    setDeletingCommentId(commentId);
    try {
      await apiDelete(`/api/issues/${issue.id}/comments/${commentId}`);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to delete comment", "error");
    } finally {
      setDeletingCommentId(null);
    }
  }

  const VISUAL_VERIFY_TAG = "needs-visual-verification";
  const isVisualVerify = issueTags.some((t) => t.name === VISUAL_VERIFY_TAG);

  async function toggleVisualVerify() {
    if (togglingVisualVerify) return;
    setTogglingVisualVerify(true);
    try {
      if (isVisualVerify) {
        const tag = issueTags.find((t) => t.name === VISUAL_VERIFY_TAG)!;
        await apiDelete(`/api/issues/${issue.id}/tags/${tag.id}`);
        setIssueTags((prev) => prev.filter((t) => t.name !== VISUAL_VERIFY_TAG));
        showToast("Removed visual verify tag");
      } else {
        // The needs-visual-verification tag is a builtin always present after server start.
        // Re-fetch from API if it's somehow missing from the local cache.
        let tag = allTags.find((t) => t.name === VISUAL_VERIFY_TAG);
        if (!tag) {
          const freshTags = await apiFetch<{ id: string; name: string; color: string | null }[]>("/api/tags");
          setAllTags(freshTags);
          tag = freshTags.find((t) => t.name === VISUAL_VERIFY_TAG);
        }
        if (!tag) {
          throw new Error(`Built-in tag "${VISUAL_VERIFY_TAG}" not found`);
        }
        await apiPost(`/api/issues/${issue.id}/tags`, { tagId: tag.id });
        setIssueTags((prev) => [...prev, tag]);
        showToast("Marked for visual verification", "success");
      }
    } catch {
      showToast("Failed to toggle visual verify tag", "error");
    } finally {
      setTogglingVisualVerify(false);
    }
  }



  async function handleStatusChange(newStatusId: string) {
    if (newStatusId === issue.statusId) return;
    const targetStatus = statuses.find((s) => s.id === newStatusId);
    const hasDeps = dependencies.dependencies.length > 0;

    const doMove = async () => {
      const isArchive = targetStatus && ["Done", "Cancelled"].includes(targetStatus.name);
      const ws = issue.workspaceSummary?.main;
      if (isArchive && ws && ws.status !== "closed") {
        setMoveToDonePending({
          confirm: async () => {
            await onUpdate(issue.id, { statusId: newStatusId });
            setMoveToDonePending(null);
          },
        });
        return;
      }
      try {
        await onUpdate(issue.id, { statusId: newStatusId });
      } catch {
        showToast("Failed to change status", "error");
      }
    };

    if (hasDeps && targetStatus) {
      setDependencyImpactPending({
        toStatusId: newStatusId,
        toStatusName: targetStatus.name,
        confirm: async () => {
          setDependencyImpactPending(null);
          await doMove();
        },
      });
      return;
    }

    await doMove();
  }

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setSaving(true);
    try {
      await onDelete(issue.id);
    } finally {
      setSaving(false);
    }
  }

  return {
    handleQuickEstimate, handleTogglePinned, handleDuplicate,
    handleAppendTouchedFilesToDescription, handleCopyArtifact, handleOpenArtifact,
    handleDeleteArtifact, handleAddNote, handleDeleteComment, handleStatusChange,
    handleDelete, isVisualVerify, toggleVisualVerify,
  };
}
