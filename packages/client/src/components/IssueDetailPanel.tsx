import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { IssueWithStatus, UpdateIssueRequest, DependencyInfo } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { showToast } from "./Toast.js";
import { MoveToDoneDialog } from "./MoveToDoneDialog.js";

interface StatusOption {
  id: string;
  name: string;
}

interface IssueDetailPanelProps {
  issue: IssueWithStatus;
  statuses: StatusOption[];
  onUpdate: (id: string, data: UpdateIssueRequest) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
  onManageWorkspaces: (issue: IssueWithStatus, workspaceId?: string) => void;
  onStartWorkspace?: (issue: IssueWithStatus) => void;
  onIssueUpdate: (issue: IssueWithStatus) => void;
  onNavigateToIssue?: (issueId: string) => void;
}

const issueTypeColors: Record<string, string> = {
  task: "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300",
  bug: "bg-red-100 text-red-700",
  feature: "bg-blue-100 text-blue-700",
  chore: "bg-amber-100 text-amber-700",
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      onClick={handleCopy}
      title={copied ? "Copied!" : "Copy issue reference"}
      className="text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 p-0.5 rounded transition-colors relative"
    >
      {copied ? (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
      {copied && (
        <span className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-xs bg-gray-800 dark:bg-gray-200 text-white dark:text-gray-800 px-1.5 py-0.5 rounded whitespace-nowrap pointer-events-none">
          Copied!
        </span>
      )}
    </button>
  );
}

export function IssueDetailPanel({
  issue,
  statuses,
  onUpdate,
  onDelete,
  onClose,
  onManageWorkspaces,
  onStartWorkspace,
  onIssueUpdate,
  onNavigateToIssue,
}: IssueDetailPanelProps) {
  const [editing, setEditing] = useState(false);
  const [descriptionMode, setDescriptionMode] = useState<"edit" | "preview">("edit");
  const [panelMode, setPanelMode] = useState<"sidebar" | "modal" | "fullscreen">("sidebar");
  const [sidebarSide, setSidebarSide] = useState<"left" | "right">("right");
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [snapZone, setSnapZone] = useState<"left" | "right" | null>(null);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; panelX: number; panelY: number } | null>(null);
  const wasDraggingRef = useRef(false);
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.description ?? "");
  const [pastedImages, setPastedImages] = useState<string[]>([]);
  const [issueType, setIssueType] = useState(issue.issueType ?? "task");
  const [estimate, setEstimate] = useState<string>(issue.estimate ?? "");
  const [skipAutoReview, setSkipAutoReview] = useState(issue.skipAutoReview ?? false);
  const [saving, setSaving] = useState(false);
  const depTypeRef = useRef<HTMLSelectElement>(null);
  const [depSearch, setDepSearch] = useState("");
  const [depDropdownOpen, setDepDropdownOpen] = useState(false);
  const [depHighlightIdx, setDepHighlightIdx] = useState(0);
  const depComboRef = useRef<HTMLDivElement>(null);
  const depInputRef = useRef<HTMLInputElement>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [preEnhanceSnapshot, setPreEnhanceSnapshot] = useState<{ title: string; description: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [togglingVisualVerify, setTogglingVisualVerify] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [moveToDonePending, setMoveToDonePending] = useState<{ confirm: () => Promise<void> } | null>(null);
  const [workspaceCount, setWorkspaceCount] = useState(0);
  const [issueTags, setIssueTags] = useState<{ id: string; name: string; color: string | null }[]>([]);
  const [allTags, setAllTags] = useState<{ id: string; name: string; color: string | null }[]>([]);
  const [dependencies, setDependencies] = useState<DependencyInfo>({ dependencies: [] });
  const [analyzingDeps, setAnalyzingDeps] = useState(false);
  const [availableIssues, setAvailableIssues] = useState<IssueWithStatus[]>([]);
  const [showFollowUp, setShowFollowUp] = useState(false);
  const [followUpTitle, setFollowUpTitle] = useState("");
  const [followUpCreating, setFollowUpCreating] = useState(false);

  // Track unsaved changes for warning
  const hasChanges = editing && (
    title !== issue.title ||
    description !== (issue.description ?? "") ||
    issueType !== (issue.issueType ?? "task") ||
    estimate !== (issue.estimate ?? "") ||
    skipAutoReview !== (issue.skipAutoReview ?? false)
  );

  useEffect(() => {
    async function loadData() {
      try {
        const [ws, tags, available, deps, issues] = await Promise.all([
          apiFetch<{ id: string }[]>(`/api/issues/${issue.id}/workspaces`),
          apiFetch<{ id: string; name: string; color: string | null }[]>(`/api/issues/${issue.id}/tags`),
          apiFetch<{ id: string; name: string; color: string | null }[]>(`/api/tags`),
          apiFetch<DependencyInfo>(`/api/issues/${issue.id}/dependencies`),
          apiFetch<IssueWithStatus[]>(`/api/issues?projectId=${issue.projectId}`),
        ]);
        setWorkspaceCount(ws.length);
        setIssueTags(tags);
        setAllTags(available);
        setDependencies(deps);
        setAvailableIssues(issues.filter(i => i.id !== issue.id));
      } catch {
        // Ignore — non-critical
      }
    }
    loadData();
  }, [issue.id]);

  // Sync local state when issue prop changes (stale data fix - F6)
  useEffect(() => {
    if (!editing) {
      setTitle(issue.title);
      setDescription(issue.description ?? "");
      setIssueType(issue.issueType ?? "task");
      setEstimate(issue.estimate ?? "");
      setSkipAutoReview(issue.skipAutoReview ?? false);
    }
  }, [issue, editing]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (editing) {
          handleCancelEdit();
        } else {
          onClose();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editing, hasChanges, issue, onClose]);

  // Close actions dropdown on outside click
  useEffect(() => {
    if (!actionsOpen) return;
    function handleClick(e: MouseEvent) {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node)) {
        setActionsOpen(false);
        setConfirmDelete(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [actionsOpen]);

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
    setSkipAutoReview(issue.skipAutoReview ?? false);
  }

  async function handleEnhance() {
    if (!title.trim() || enhancing) return;
    setEnhancing(true);
    try {
      setPreEnhanceSnapshot({ title, description });
      const result = await apiFetch<{ title: string; description: string }>("/api/issues/enhance", {
        method: "POST",
        body: JSON.stringify({ title, description, projectId: issue.projectId }),
      });
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

  async function handleAnalyzeDeps() {
    if (analyzingDeps) return;
    setAnalyzingDeps(true);
    try {
      const result = await apiFetch<{ dependencies: Array<{ id: string; type: string; issueId: string; reason: string }>; total: number }>("/api/issues/analyze-dependencies", {
        method: "POST",
        body: JSON.stringify({ issueId: issue.id, projectId: issue.projectId }),
      });
      // Reload dependencies to show newly created ones
      const deps = await apiFetch<DependencyInfo>(`/api/issues/${issue.id}/dependencies`);
      setDependencies(deps);
      if (result.total > 0) {
        showToast(`Added ${result.total} dependenc${result.total === 1 ? "y" : "ies"}`, "success");
      } else {
        showToast("No new dependencies found");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Dependency analysis failed", "error");
    } finally {
      setAnalyzingDeps(false);
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
        await apiFetch(`/api/issues/${issue.id}/tags/${tag.id}`, { method: "DELETE" });
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
        await apiFetch(`/api/issues/${issue.id}/tags`, {
          method: "POST",
          body: JSON.stringify({ tagId: tag.id }),
        });
        setIssueTags((prev) => [...prev, tag!]);
        showToast("Marked for visual verification", "success");
      }
    } catch {
      showToast("Failed to toggle visual verify tag", "error");
    } finally {
      setTogglingVisualVerify(false);
    }
  }

  async function handleCreateFollowUp() {
    if (!followUpTitle.trim() || followUpCreating) return;
    setFollowUpCreating(true);
    try {
      const newIssue = await apiFetch<{ id: string }>("/api/issues", {
        method: "POST",
        body: JSON.stringify({ title: followUpTitle.trim(), description: "", priority: "medium", projectId: issue.projectId }),
      });
      await apiFetch(`/api/issues/${newIssue.id}/dependencies`, {
        method: "POST",
        body: JSON.stringify({ dependsOnId: issue.id, type: "depends_on" }),
      }).catch(() => {});
      setFollowUpTitle("");
      setShowFollowUp(false);
      showToast("Follow-up task created", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to create follow-up", "error");
    } finally {
      setFollowUpCreating(false);
    }
  }

  async function handleSave() {
    if (saving) return;
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
      });
      setPastedImages([]);
      setEditing(false);
      setDescriptionMode("edit");
      // Don't close panel — F1 fix. Parent will re-render with updated data.
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(newStatusId: string) {
    if (newStatusId === issue.statusId) return;
    const targetStatus = statuses.find((s) => s.id === newStatusId);
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

  function handleHeaderMouseDown(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest("button")) return;
    const panel = (e.currentTarget as HTMLElement).closest("[data-panel]") as HTMLElement;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragStartRef.current = { mouseX: e.clientX, mouseY: e.clientY, panelX: rect.left, panelY: rect.top };

    // Snap thresholds based on mouse position (not panel edge)
    const EDGE_SNAP_THRESHOLD = 100; // px from screen edge where mouse triggers snap
    const MODAL_WIDTH = Math.min(800, window.innerWidth * 0.96);
    // Track current drag mode via ref to avoid stale closure issues
    let currentDragMode: "sidebar" | "modal" | "fullscreen" = panelMode;
    let cleanup: (() => void) | null = null;

    // If starting drag from sidebar, immediately switch to modal mode
    if (currentDragMode === "sidebar") {
      const modalWidth = Math.min(800, window.innerWidth * 0.96);
      // Position modal so the grab offset relative to panel left is preserved
      const grabOffsetX = e.clientX - rect.left;
      const idealModalX = e.clientX - Math.min(grabOffsetX, modalWidth - 80);
      const modalX = Math.max(0, Math.min(window.innerWidth - modalWidth, idealModalX));
      const modalY = Math.max(0, window.innerHeight * 0.05);
      currentDragMode = "modal";
      setPanelMode("modal");
      setDragPos({ x: modalX, y: modalY });
      // Reset drag origin to current mouse + modal position so subsequent moves are relative to now
      dragStartRef.current = { mouseX: e.clientX, mouseY: e.clientY, panelX: modalX, panelY: modalY };
    }

    const onMove = (ev: MouseEvent) => {
      if (!dragStartRef.current) return;
      const dx = ev.clientX - dragStartRef.current.mouseX;
      const dy = ev.clientY - dragStartRef.current.mouseY;
      const newX = dragStartRef.current.panelX + dx;
      const newY = dragStartRef.current.panelY + dy;
      if (currentDragMode === "modal") {
        // Snap based on mouse position relative to screen edges
        const mouseNearRightEdge = ev.clientX >= window.innerWidth - EDGE_SNAP_THRESHOLD;
        const mouseNearLeftEdge = ev.clientX <= EDGE_SNAP_THRESHOLD;
        if (mouseNearRightEdge) {
          currentDragMode = "sidebar";
          setPanelMode("sidebar");
          setSidebarSide("right");
          setSnapZone(null);
          setDragPos(null);
          dragStartRef.current = null;
          cleanup?.();
          return;
        }
        if (mouseNearLeftEdge) {
          currentDragMode = "sidebar";
          setPanelMode("sidebar");
          setSidebarSide("left");
          setSnapZone(null);
          setDragPos(null);
          dragStartRef.current = null;
          cleanup?.();
          return;
        }
        // Show snap zone preview when mouse approaches edges
        const SNAP_PREVIEW_THRESHOLD = EDGE_SNAP_THRESHOLD + 80;
        const approachingRight = ev.clientX >= window.innerWidth - SNAP_PREVIEW_THRESHOLD;
        const approachingLeft = ev.clientX <= SNAP_PREVIEW_THRESHOLD;
        setSnapZone(approachingRight ? "right" : approachingLeft ? "left" : null);
        setDragPos({ x: newX, y: newY });
      }
    };
    const onUp = () => {
      dragStartRef.current = null;
      wasDraggingRef.current = true;
      setSnapZone(null);
      cleanup?.();
      // Reset drag flag after current event cycle so backdrop onClick is suppressed
      setTimeout(() => { wasDraggingRef.current = false; }, 0);
    };
    cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function handleBackdropClick() {
    if (wasDraggingRef.current) return;
    if (editing && hasChanges) {
      if (!window.confirm("You have unsaved changes. Discard?")) return;
    }
    onClose();
  }

  const badgeColor = issueTypeColors[issue.issueType ?? "task"] ?? "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300";

  return (
    <>
      {/* Snap zone indicators shown while dragging */}
      {snapZone === "left" && (
        <div className="fixed left-0 top-0 h-full w-[min(384px,100vw)] z-40 bg-blue-500/20 border-r-2 border-blue-400 pointer-events-none transition-opacity" />
      )}
      {snapZone === "right" && (
        <div className="fixed right-0 top-0 h-full w-[min(384px,100vw)] z-40 bg-blue-500/20 border-l-2 border-blue-400 pointer-events-none transition-opacity" />
      )}
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 z-40"
        onClick={handleBackdropClick}
      />
      {/* Panel */}
      <div
        data-panel
        className={`fixed bg-white dark:bg-gray-900 shadow-xl z-50 flex flex-col animate-slide-in-right ${
          panelMode === "fullscreen"
            ? "inset-0"
            : panelMode === "modal"
            ? `w-[min(800px,96vw)] h-[90vh] rounded-lg border border-gray-200 dark:border-gray-700${dragPos ? "" : " top-[5vh] left-1/2 -translate-x-1/2"}`
            : sidebarSide === "left"
            ? "left-0 top-0 h-full border-r border-gray-200 dark:border-gray-700 w-[min(384px,100vw)]"
            : "right-0 top-0 h-full border-l border-gray-200 dark:border-gray-700 w-[min(384px,100vw)]"
        }`}
        style={
          dragPos && panelMode === "modal"
            ? { position: "fixed", left: dragPos.x, top: dragPos.y, transform: "none" }
            : panelMode === "sidebar" && dragPos
            ? { right: "auto", left: dragPos.x, top: dragPos.y, height: "min(90vh, 100vh)" }
            : undefined
        }
      >
        <div
          className={`flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 ${panelMode === "sidebar" || panelMode === "modal" ? "cursor-grab active:cursor-grabbing" : ""} ${panelMode === "modal" ? "rounded-t-lg" : ""}`}
          onMouseDown={panelMode === "sidebar" || panelMode === "modal" ? handleHeaderMouseDown : undefined}
        >
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            {issue.issueNumber != null && (
              <span className="flex items-center gap-1">
                <span className="text-gray-400 dark:text-gray-500 font-mono">#{issue.issueNumber}</span>
                <CopyButton text={`#${issue.issueNumber} ${issue.title}`} />
              </span>
            )}
            {editing ? "Edit Issue" : "Issue Details"}
          </h2>
          <div className="flex items-center gap-1">
            {!editing && (
              <button
                onClick={toggleVisualVerify}
                disabled={togglingVisualVerify}
                title={isVisualVerify ? "Unmark visual verification" : "Mark for visual verification"}
                className={`p-0.5 rounded transition-colors disabled:opacity-50 ${isVisualVerify ? "text-amber-500 hover:text-amber-600" : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"}`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              </button>
            )}
            {!editing && (
              <div ref={actionsRef} className="relative">
                <button
                  onClick={() => { setActionsOpen((o) => !o); setConfirmDelete(false); }}
                  title="Actions"
                  className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 p-0.5 rounded"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                  </svg>
                </button>
                {actionsOpen && (
                  <div className="absolute right-0 top-full mt-1 w-40 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 py-1">
                    <button
                      onClick={() => { setEditing(true); setActionsOpen(false); }}
                      className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete()}
                      disabled={saving}
                      className={`w-full text-left px-3 py-2 text-sm disabled:opacity-50 flex items-center gap-2 ${
                        confirmDelete
                          ? "text-red-600 bg-red-50 dark:bg-red-950 hover:bg-red-100 dark:hover:bg-red-900"
                          : "text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                      }`}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      {confirmDelete ? "Confirm Delete" : "Delete"}
                    </button>
                  </div>
                )}
              </div>
            )}
            <button
              onClick={() => {
                setPanelMode((m) => {
                  if (m === "fullscreen") setSidebarSide("right");
                  return m === "sidebar" ? "modal" : m === "modal" ? "fullscreen" : "sidebar";
                });
                setDragPos(null);
              }}
              title={panelMode === "sidebar" ? "Expand to modal" : panelMode === "modal" ? "Expand to fullscreen" : "Collapse to sidebar"}
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 p-0.5 rounded"
            >
              {panelMode === "fullscreen" ? (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 9L4 4m0 0h5m-5 0v5M15 9l5-5m0 0h-5m5 0v5M9 15l-5 5m0 0h5m-5 0v-5M15 15l5 5m0 0h-5m5 0v-5" />
                </svg>
              ) : panelMode === "modal" ? (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5M20 8V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5M20 16v4m0 0h-4m4 0l-5-5" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5M20 8V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5M20 16v4m0 0h-4m4 0l-5-5" />
                </svg>
              )}
            </button>
            <button
              onClick={handleBackdropClick}
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
            >
              &times;
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Blocked banner — shown when issue has unresolved blocking dependencies */}
          {(() => {
            const RESOLVED = ["done", "cancelled", "ai reviewed"];
            const blockingDeps = dependencies.dependencies.filter((dep) => {
              const isIncoming = dep.issueId !== issue.id;
              const isBlockingType = dep.type === "depends_on" || dep.type === "blocked_by";
              if (!isBlockingType) return false;
              if (isIncoming) return false; // incoming depends_on means I'm blocking them, not the other way
              const statusLower = (dep.issueStatusName ?? "").toLowerCase();
              return !RESOLVED.includes(statusLower);
            });
            if (blockingDeps.length === 0) return null;
            return (
              <div className="bg-amber-50 border border-amber-300 rounded-md px-3 py-2.5 text-sm">
                <div className="flex items-center gap-1.5 font-medium text-amber-800 mb-1.5">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  Blocked by {blockingDeps.length} unresolved {blockingDeps.length === 1 ? "dependency" : "dependencies"}
                </div>
                <ul className="space-y-0.5 pl-5.5">
                  {blockingDeps.map((dep) => (
                    <li key={dep.id} className="text-amber-700 flex items-center gap-1">
                      <span className="text-amber-500 shrink-0">•</span>
                      {dep.issueNumber != null && (
                        <span className="font-mono text-xs shrink-0">#{dep.issueNumber}</span>
                      )}
                      <span className="truncate">{dep.issueTitle}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}

          {/* Title - always visible, editable in edit mode */}
          <div>
            {editing ? (
              <>
                <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1">
                  Title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </>
            ) : (
              <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">
                {issue.title}
              </h3>
            )}
          </div>

          {/* Description - always visible, editable in edit mode */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Description
              </label>
              {editing && (
                <div className="flex border border-gray-300 dark:border-gray-600 rounded overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setDescriptionMode("edit")}
                    className={`text-xs px-2 py-0.5 ${descriptionMode === "edit" ? "bg-blue-500 text-white" : "bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"}`}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setDescriptionMode("preview")}
                    className={`text-xs px-2 py-0.5 border-l border-gray-300 dark:border-gray-600 ${descriptionMode === "preview" ? "bg-blue-500 text-white" : "bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"}`}
                  >
                    Preview
                  </button>
                </div>
              )}
            </div>
            {editing ? (
              <>
              {descriptionMode === "preview" ? (
                description ? (
                  <div className="markdown-body min-h-[6rem] border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5">
                    <ReactMarkdown>{description}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 dark:text-gray-500 italic min-h-[6rem] border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5">Nothing to preview.</p>
                )
              ) : (
              <>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={panelMode !== "sidebar" ? 16 : 4}
                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                placeholder="Add a description... (paste screenshots with Ctrl+V)"
                onPaste={(e) => {
                  const items = e.clipboardData?.items;
                  if (!items) return;
                  for (const item of Array.from(items)) {
                    if (item.type.startsWith("image/")) {
                      e.preventDefault();
                      const file = item.getAsFile();
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = (ev) => {
                        const dataUrl = ev.target?.result as string;
                        setPastedImages((prev) => [...prev, dataUrl]);
                      };
                      reader.readAsDataURL(file);
                      return;
                    }
                  }
                }}
              />
              {pastedImages.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {pastedImages.map((url, i) => (
                    <div key={i} className="relative group">
                      <img src={url} alt={`screenshot-${i + 1}`} className="h-16 w-auto rounded border border-gray-200 dark:border-gray-700 object-cover" />
                      <button
                        type="button"
                        onClick={() => setPastedImages((prev) => prev.filter((_, j) => j !== i))}
                        className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-500 text-white rounded-full text-xs leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      >×</button>
                    </div>
                  ))}
                </div>
              )}
              </>
              )}
              </>
            ) : issue.description ? (
              <div className="markdown-body">
                <ReactMarkdown>{issue.description}</ReactMarkdown>
              </div>
            ) : (
              <p className="text-sm text-gray-400 dark:text-gray-500 italic">
                No description. Click edit to add one.
              </p>
            )}
          </div>

          {/* Status - always visible, dropdown in view mode */}
          <div>
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1">
              Status
            </label>
            <select
              value={issue.statusId}
              onChange={(e) => handleStatusChange(e.target.value)}
              disabled={editing}
              className={`w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 ${editing ? "bg-gray-50 dark:bg-gray-950 text-gray-500 dark:text-gray-400" : ""}`}
            >
              {statuses.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          {/* Type - always visible, editable in edit mode */}
          <div>
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1">
              Type
            </label>
            {editing ? (
              <select
                value={issueType}
                onChange={(e) => setIssueType(e.target.value)}
                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="task">Task</option>
                <option value="bug">Bug</option>
                <option value="feature">Feature</option>
                <option value="chore">Chore</option>
              </select>
            ) : (
              <span className={`inline-block text-xs font-medium px-1.5 py-0.5 rounded capitalize ${badgeColor}`}>
                {issue.issueType ?? "task"}
              </span>
            )}
          </div>

          {/* Estimate */}
          <div>
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1">
              Estimate
            </label>
            {editing ? (
              <select
                value={estimate}
                onChange={(e) => setEstimate(e.target.value)}
                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">None</option>
                <option value="XS">XS</option>
                <option value="S">S</option>
                <option value="M">M</option>
                <option value="L">L</option>
                <option value="XL">XL</option>
              </select>
            ) : issue.estimate ? (
              <span className="inline-block text-xs font-medium px-1.5 py-0.5 rounded bg-teal-100 text-teal-700">
                {issue.estimate}
              </span>
            ) : (
              <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
            )}
          </div>

          {/* Skip auto review indicator - view mode only */}
          {!editing && issue.skipAutoReview && (
            <div>
              <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
                Skip auto review
              </span>
            </div>
          )}

          {/* Skip auto review toggle - edit mode only */}
          {editing && (
            <div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={skipAutoReview}
                  onChange={(e) => setSkipAutoReview(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">Skip auto AI code review</span>
              </label>
            </div>
          )}

          {/* Workspaces section - always visible */}
          {!editing && (
            <div>
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1">
                Workspaces
              </label>
              {issue.workspaceSummary?.main ? (
                <div className="flex flex-col gap-1">
                  <button
                    onClick={() => onManageWorkspaces(issue, issue.workspaceSummary!.main!.id)}
                    className={`w-full flex flex-col gap-1 p-2 rounded border transition-colors text-left ${
                      issue.workspaceSummary.main.conflicts?.hasConflicts
                        ? "border-red-200 dark:border-red-800 hover:border-red-300 dark:hover:border-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                        : "border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950"
                    }`}
                  >
                    <div className="flex items-center gap-2 w-full">
                      <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${
                        issue.workspaceSummary.main.status === "active" ? "bg-green-500" :
                        issue.workspaceSummary.main.status === "reviewing" ? "bg-purple-500 animate-pulse" :
                        issue.workspaceSummary.main.status === "fixing" ? "bg-orange-500 animate-pulse" :
                        issue.workspaceSummary.main.status === "error" ? "bg-red-500" :
                        issue.workspaceSummary.main.conflicts?.hasConflicts ? "bg-red-500" :
                        issue.workspaceSummary.main.status === "idle" ? "bg-amber-500" :
                        "bg-gray-400"
                      }`} />
                      <span className="text-sm font-mono text-gray-700 dark:text-gray-300 truncate">{issue.workspaceSummary.main.branch}</span>
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${
                        issue.workspaceSummary.main.status === "active" ? "bg-green-100 text-green-700" :
                        issue.workspaceSummary.main.status === "reviewing" ? "bg-purple-100 text-purple-700" :
                        issue.workspaceSummary.main.status === "fixing" ? "bg-orange-100 text-orange-700" :
                        issue.workspaceSummary.main.status === "error" ? "bg-red-100 text-red-700" :
                        issue.workspaceSummary.main.conflicts?.hasConflicts ? "bg-red-100 text-red-700" :
                        issue.workspaceSummary.main.status === "idle" ? "bg-amber-100 text-amber-700" :
                        issue.workspaceSummary.main.status === "closed" && issue.workspaceSummary.main.lastSessionTriggerType === "fix-conflicts" ? "bg-orange-100 text-orange-700" :
                        "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
                      }`}>
                        {issue.workspaceSummary.main.status === "reviewing" ? "AI Reviewing" :
                         issue.workspaceSummary.main.status === "fixing" ? "AI Fixing Conflicts" :
                         issue.workspaceSummary.main.status === "error" ? "Preflight Error" :
                         issue.workspaceSummary.main.conflicts?.hasConflicts ? "Merge Conflicts" :
                         issue.workspaceSummary.main.status === "closed" && issue.workspaceSummary.main.lastSessionTriggerType === "fix-conflicts" ? "merged conflicts" :
                         issue.workspaceSummary.main.status}
                      </span>
                      {issue.workspaceSummary.main.conflicts?.hasConflicts && issue.workspaceSummary.main.status !== "fixing" && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-medium shrink-0">
                          {issue.workspaceSummary.main.conflicts.conflictingFiles.length} file{issue.workspaceSummary.main.conflicts.conflictingFiles.length !== 1 ? "s" : ""}
                        </span>
                      )}
                      {issue.workspaceSummary!.total > 1 && (
                        <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">+{issue.workspaceSummary!.total - 1}</span>
                      )}
                    </div>
                    {(issue.workspaceSummary.main.status === "active" || issue.workspaceSummary.main.status === "fixing") && (issue.workspaceSummary.main.contextTokens || issue.workspaceSummary.main.lastTool) && (
                      <div className="flex items-center gap-2 pl-4">
                        {issue.workspaceSummary.main.contextTokens ? (
                          <span className="text-[10px] text-gray-400 dark:text-gray-500">
                            {issue.workspaceSummary.main.contextTokens >= 1000
                              ? `${Math.round(issue.workspaceSummary.main.contextTokens / 1000)}k ctx`
                              : `${issue.workspaceSummary.main.contextTokens} ctx`}
                          </span>
                        ) : null}
                        {issue.workspaceSummary.main.lastTool ? (
                          <span className="text-[10px] text-gray-400 dark:text-gray-500 truncate" title={issue.workspaceSummary.main.lastTool}>
                            {issue.workspaceSummary.main.lastTool}
                          </span>
                        ) : null}
                      </div>
                    )}
                  </button>
                  {issue.workspaceSummary.main.conflicts?.hasConflicts && (
                    <button
                      onClick={() => onManageWorkspaces(issue, issue.workspaceSummary!.main!.id)}
                      className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded bg-red-600 text-white hover:bg-red-700 transition-colors self-start"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                      </svg>
                      Fix with AI
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  {onStartWorkspace && (
                    <button
                      onClick={() => onStartWorkspace(issue)}
                      className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      Start Workspace
                    </button>
                  )}
                  <button
                    onClick={() => onManageWorkspaces(issue)}
                    className="text-sm text-blue-600 hover:text-blue-700"
                  >
                    {workspaceCount === 0 ? "Custom options..." : "View Workspaces"}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Tags section - visible in both view and edit mode */}
          <div>
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1">
                Tags
              </label>
              <div className="flex flex-wrap gap-1.5">
                {issueTags.map((tag) => (
                  <span
                    key={tag.id}
                    className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                    style={tag.color ? { backgroundColor: tag.color + "22", color: tag.color } : undefined}
                  >
                    {tag.name}
                    <button
                      onClick={async () => {
                        try {
                          await apiFetch(`/api/issues/${issue.id}/tags/${tag.id}`, { method: "DELETE" });
                          setIssueTags((prev) => prev.filter((t) => t.id !== tag.id));
                        } catch {
                          showToast("Failed to remove tag", "error");
                        }
                      }}
                      className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
                    >
                      &times;
                    </button>
                  </span>
                ))}
                {allTags.filter((t) => !issueTags.some((it) => it.id === t.id)).length > 0 && (
                  <select
                    className="text-xs border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    value=""
                    onChange={async (e) => {
                      const tagId = e.target.value;
                      if (!tagId) return;
                      try {
                        await apiFetch(`/api/issues/${issue.id}/tags`, {
                          method: "POST",
                          body: JSON.stringify({ tagId }),
                        });
                        const tag = allTags.find((t) => t.id === tagId);
                        if (tag) setIssueTags((prev) => [...prev, tag]);
                      } catch {
                        showToast("Failed to add tag", "error");
                      }
                    }}
                  >
                    <option value="">+ Add tag</option>
                    {allTags
                      .filter((t) => !issueTags.some((it) => it.id === t.id))
                      .map((tag) => (
                        <option key={tag.id} value={tag.id}>{tag.name}</option>
                      ))}
                  </select>
                )}
              </div>
            </div>

          {/* Dependencies section */}
          <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                  Dependencies
                </label>
                <button
                  onClick={handleAnalyzeDeps}
                  disabled={analyzingDeps}
                  className="text-[10px] text-purple-600 hover:text-purple-700 font-medium px-1.5 py-0.5 rounded border border-purple-200 hover:bg-purple-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                  title="Analyze dependencies with AI"
                >
                  {analyzingDeps && (
                    <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                    </svg>
                  )}
                  {analyzingDeps ? "Analyzing..." : "Analyze Deps"}
                </button>
              </div>
              {dependencies.dependencies.length > 0 ? (
                <div className="space-y-1.5">
                  {(() => {
                    // Compute effective display type based on direction
                    // For incoming deps, we show the inverse perspective
                    type DisplayCategory = "depends_on" | "blocked_by" | "blocking" | "child_of" | "parent_of" | "related_to" | "duplicates";

                    function getDisplayType(dep: typeof dependencies.dependencies[number]): DisplayCategory {
                      const isOutgoing = dep.issueId === issue.id;
                      if (isOutgoing) {
                        // Outgoing: use the type as-is (but depends_on stays depends_on, blocked_by stays blocked_by)
                        return dep.type as DisplayCategory;
                      }
                      // Incoming: invert
                      switch (dep.type) {
                        case "depends_on": return "blocking";    // someone depends on me = I'm blocking them
                        case "blocked_by": return "blocking";   // someone blocked by me = I'm blocking them
                        case "parent_of": return "child_of";    // someone is my parent = I'm their child
                        case "child_of": return "parent_of";    // someone is my child = I'm their parent
                        case "related_to": return "related_to";
                        case "duplicates": return "duplicates";
                        default: return "related_to";
                      }
                    }

                    const DISPLAY_LABELS: Record<DisplayCategory, string> = {
                      depends_on: "Depends on",
                      blocked_by: "Blocked by",
                      blocking: "Blocking",
                      related_to: "Related to",
                      duplicates: "Duplicates",
                      parent_of: "Parent of",
                      child_of: "Child of",
                    };

                    type DepWithDisplay = typeof dependencies.dependencies[number] & { displayType: DisplayCategory };
                    const depsWithDisplay: DepWithDisplay[] = dependencies.dependencies.map((dep) => ({
                      ...dep,
                      displayType: getDisplayType(dep),
                    }));

                    // Group by display type
                    const byDisplayType = new Map<DisplayCategory, DepWithDisplay[]>();
                    for (const dep of depsWithDisplay) {
                      const list = byDisplayType.get(dep.displayType) ?? [];
                      list.push(dep);
                      byDisplayType.set(dep.displayType, list);
                    }

                    const typeOrder: DisplayCategory[] = ["depends_on", "blocked_by", "blocking", "child_of", "parent_of", "related_to", "duplicates"];
                    const typeColors: Record<DisplayCategory, string> = {
                      depends_on: "bg-blue-50 text-blue-700",
                      blocked_by: "bg-red-50 text-red-700",
                      blocking: "bg-orange-50 text-orange-700",
                      related_to: "bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300",
                      duplicates: "bg-yellow-50 text-yellow-700",
                      parent_of: "bg-green-50 text-green-700",
                      child_of: "bg-purple-50 text-purple-700",
                    };
                    return typeOrder
                      .filter((t) => byDisplayType.has(t))
                      .map((t) => (
                        <div key={t}>
                          <span className="text-xs text-gray-500 dark:text-gray-400 block mb-0.5">
                            {DISPLAY_LABELS[t]}:
                          </span>
                          <div className="flex flex-wrap gap-1.5">
                            {byDisplayType.get(t)!.map((dep) => {
                              const isOutgoing = dep.issueId === issue.id;
                              const targetIssueId = isOutgoing ? dep.dependsOnId : dep.issueId;
                              const showBlockingDot = dep.issueStatusName !== "Done" && dep.issueStatusName !== "AI Reviewed" &&
                                (dep.displayType === "depends_on" || dep.displayType === "blocked_by" || dep.displayType === "child_of");
                              return (
                                <span
                                  key={dep.id}
                                  className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full cursor-pointer hover:opacity-80 ${typeColors[t]}`}
                                  onClick={() => onNavigateToIssue?.(targetIssueId)}
                                  title={`#${dep.issueNumber ?? ""} ${dep.issueTitle}`}
                                >
                                  {showBlockingDot && (
                                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                                  )}
                                  {!showBlockingDot && dep.issueStatusName !== "Done" && dep.issueStatusName !== "AI Reviewed" && (
                                    <span className="w-1.5 h-1.5 rounded-full bg-gray-300 dark:bg-gray-600 shrink-0" />
                                  )}
                                  {(dep.issueStatusName === "Done" || dep.issueStatusName === "AI Reviewed") && (
                                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                                  )}
                                  <span className="truncate max-w-[120px]">{dep.issueTitle}</span>
                                  <button
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      try {
                                        await apiFetch(`/api/issues/${issue.id}/dependencies/${dep.id}`, { method: "DELETE" });
                                        setDependencies((prev) => ({
                                          dependencies: prev.dependencies.filter((d) => d.id !== dep.id),
                                        }));
                                        onIssueUpdate(issue);
                                      } catch {
                                        showToast("Failed to remove dependency", "error");
                                      }
                                    }}
                                    className="opacity-50 hover:opacity-100"
                                  >
                                    &times;
                                  </button>
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      ));
                  })()}
                </div>
              ) : null}
              {(() => {
                const existingTargetIds = new Set(
                  dependencies.dependencies
                    .filter((d) => d.issueId === issue.id)
                    .map((d) => d.dependsOnId)
                );
                const candidates = availableIssues.filter((i) => !existingTargetIds.has(i.id));
                const filteredCandidates = candidates.filter((i) => {
                  const q = depSearch.toLowerCase();
                  return (
                    (i.issueNumber != null && String(i.issueNumber).includes(q)) ||
                    i.title.toLowerCase().includes(q)
                  );
                });
                const addDep = async (depId: string) => {
                  const depType = depTypeRef.current?.value || "depends_on";
                  try {
                    await apiFetch(`/api/issues/${issue.id}/dependencies`, {
                      method: "POST",
                      body: JSON.stringify({ dependsOnId: depId, type: depType }),
                    });
                    const deps = await apiFetch<DependencyInfo>(`/api/issues/${issue.id}/dependencies`);
                    setDependencies(deps);
                    onIssueUpdate(issue);
                    setDepSearch("");
                    setDepDropdownOpen(false);
                    setDepHighlightIdx(0);
                  } catch (err: any) {
                    const msg = err?.message ?? "Failed to add dependency";
                    showToast(msg, "error");
                  }
                };
                return candidates.length > 0 ? (
                  <div className="flex gap-1 mt-1.5">
                    <div ref={depComboRef} className="relative">
                      <input
                        ref={depInputRef}
                        type="text"
                        className="text-xs border border-gray-300 dark:border-gray-600 rounded px-1.5 py-0.5 w-44 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        placeholder="+ Add dependency…"
                        value={depSearch}
                        onChange={(e) => {
                          setDepSearch(e.target.value);
                          setDepDropdownOpen(true);
                          setDepHighlightIdx(0);
                        }}
                        onFocus={() => setDepDropdownOpen(true)}
                        onBlur={(e) => {
                          if (!depComboRef.current?.contains(e.relatedTarget as Node)) {
                            setDepDropdownOpen(false);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (!depDropdownOpen) {
                            if (e.key === "ArrowDown" || e.key === "Enter") setDepDropdownOpen(true);
                            return;
                          }
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setDepHighlightIdx((p) => Math.min(p + 1, filteredCandidates.length - 1));
                          } else if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setDepHighlightIdx((p) => Math.max(p - 1, 0));
                          } else if (e.key === "Enter") {
                            e.preventDefault();
                            const item = filteredCandidates[depHighlightIdx];
                            if (item) addDep(item.id);
                          } else if (e.key === "Escape") {
                            setDepDropdownOpen(false);
                            setDepSearch("");
                          }
                        }}
                      />
                      {depDropdownOpen && (
                        <div className="absolute z-50 top-full left-0 mt-0.5 w-64 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded shadow-lg max-h-48 overflow-y-auto">
                          {filteredCandidates.length === 0 ? (
                            <div className="text-xs text-gray-400 dark:text-gray-500 px-2 py-1.5">No matches</div>
                          ) : (
                            filteredCandidates.map((i, idx) => (
                              <button
                                key={i.id}
                                tabIndex={-1}
                                className={`w-full text-left text-xs px-2 py-1 truncate ${idx === depHighlightIdx ? "bg-blue-100 text-blue-800" : "hover:bg-gray-100 dark:hover:bg-gray-800"}`}
                                onMouseDown={(e) => { e.preventDefault(); addDep(i.id); }}
                                onMouseEnter={() => setDepHighlightIdx(idx)}
                              >
                                {i.issueNumber != null ? <span className="font-mono text-gray-500 dark:text-gray-400">#{i.issueNumber} </span> : null}
                                {i.title}
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                    <select
                      ref={depTypeRef}
                      className="text-xs border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      defaultValue="depends_on"
                    >
                      <option value="depends_on">depends on</option>
                      <option value="blocked_by">blocked by</option>
                      <option value="related_to">related to</option>
                      <option value="duplicates">duplicates</option>
                      <option value="parent_of">parent of</option>
                      <option value="child_of">child of</option>
                    </select>
                  </div>
                ) : null;
              })()}
            </div>

          {/* Follow-up task creation */}
          <div className="pt-2">
            {!showFollowUp ? (
              <button
                onClick={() => setShowFollowUp(true)}
                className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
              >
                <span className="font-bold text-sm leading-none">+</span> Create follow-up task
              </button>
            ) : (
              <div className="flex gap-1.5 items-center">
                <input
                  autoFocus
                  type="text"
                  value={followUpTitle}
                  onChange={(e) => setFollowUpTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreateFollowUp(); if (e.key === "Escape") { setShowFollowUp(false); setFollowUpTitle(""); } }}
                  placeholder="Follow-up task title..."
                  className="flex-1 text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  onClick={handleCreateFollowUp}
                  disabled={!followUpTitle.trim() || followUpCreating}
                  className="text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
                >{followUpCreating ? "…" : "Create"}</button>
                <button onClick={() => { setShowFollowUp(false); setFollowUpTitle(""); }} className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300">✕</button>
              </div>
            )}
          </div>

          {/* Timestamps */}
          <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400 dark:text-gray-500">
              <span>Created {formatRelativeTime(issue.createdAt)}</span>
              <span>Updated {formatRelativeTime(issue.updatedAt)}</span>
              {issue.statusChangedAt && (
                <span>Moved to <span className="text-gray-500 dark:text-gray-400 font-medium">{issue.statusName}</span> {formatRelativeTime(issue.statusChangedAt)}</span>
              )}
            </div>
          </div>
        </div>

        {/* Edit mode actions — shown in footer when editing */}
        {editing && (
          <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={saving || !title.trim()}
              className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              onClick={handleCancelEdit}
              className="text-sm text-gray-500 dark:text-gray-400 px-4 py-1.5 hover:text-gray-700 dark:hover:text-gray-300"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleEnhance}
              disabled={!title.trim() || enhancing}
              title="Enhance with AI"
              className="ml-auto text-sm text-purple-600 px-2 py-1.5 hover:text-purple-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
            >
              {enhancing ? (
                <svg className="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l1.5 3.5L10 8l-3.5 1.5L5 13l-1.5-3.5L0 8l3.5-1.5L5 3zM19 11l1 2.5L22.5 14l-2.5 1L19 17.5l-1-2.5L15.5 14l2.5-1L19 11z" />
                </svg>
              )}
              {enhancing ? "Enhancing..." : "Enhance"}
            </button>
            {preEnhanceSnapshot && (
              <button
                type="button"
                onClick={handleUndoEnhance}
                title="Undo enhancement"
                className="text-sm text-gray-500 dark:text-gray-400 px-2 py-1.5 hover:text-gray-700 dark:hover:text-gray-300 flex items-center gap-1"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                </svg>
                Undo
              </button>
            )}
          </div>
        )}
      </div>
      {moveToDonePending && (
        <MoveToDoneDialog
          issue={issue}
          onConfirm={moveToDonePending.confirm}
          onCancel={() => setMoveToDonePending(null)}
        />
      )}
    </>
  );
}
