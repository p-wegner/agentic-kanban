import React, { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { IssueWithStatus, UpdateIssueRequest } from "@agentic-kanban/shared";
import { MarkdownToolbar } from "./MarkdownToolbar.js";
import { IssueWorkspacesSection } from "./IssueWorkspacesSection.js";
import { IssueDetailDialogs, type MoveToDonePending, type DependencyImpactPending } from "./IssueDetailDialogs.js";
import { usePanelLayout } from "../hooks/usePanelLayout.js";
import { useIssueEditForm } from "../hooks/useIssueEditForm.js";
import { useIssueDetailData } from "../hooks/useIssueDetailData.js";
import { useIssueInlineEdit } from "../hooks/useIssueInlineEdit.js";
import { useIssueActions } from "../hooks/useIssueActions.js";
import { IssueSecondaryDetails } from "./IssueSecondaryDetails.js";
import { IssueMetadataGrid } from "./IssueMetadataGrid.js";
import type { TrailEntry } from "../hooks/useTicketTrail.js";
import { TicketTrailStrip } from "./TicketTrailStrip.js";
import { IssueCycleTimeBadge } from "./IssueCycleTimeBadge.js";
import { IssueWorkLogSection } from "./IssueWorkLogSection.js";
import { useIssueDisplayData } from "../hooks/useIssueDisplayData.js";
import { useModalDrag } from "../hooks/useModalDrag.js";
import { normalizeMarkdown } from "../lib/artifact-utils.js";
import { copyIssueArtifactContent, openIssueArtifact } from "./IssueArtifactsSection.js";
import { IssueDetailHeader } from "./IssueDetailHeader.js";
import { IssueEditFooter } from "./IssueEditFooter.js";

// Re-exported so existing importers/tests keep working after the helpers moved
// into lib/artifact-utils.ts and lib/artifact-classifiers.ts.
export { issueArtifactPreview } from "../lib/artifact-utils.js";
export { issueArtifactKind, issueArtifactAuthor } from "../lib/artifact-classifiers.js";
import { canDecomposeIssue } from "../lib/blockingDependencies.js";
import { IssueBlockedBanner } from "./IssueBlockedBanner.js";

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
  onManageWorkspaces: (issue: IssueWithStatus, workspaceId?: string, sessionId?: string) => void;
  onStartWorkspace?: (issue: IssueWithStatus) => void;
  onIssueUpdate: (issue: IssueWithStatus) => void;
  onNavigateToIssue?: (issueId: string) => void;
  /** Navigate to the graph view and focus this issue. */
  onViewInGraph?: (issueId: string) => void;
  /**
   * Open the butler with this ticket's context pre-loaded (#838) — for asking
   * "what took so long", "where did the agents fail", "what context was missing",
   * etc., and digging into the ticket's transcript.
   */
  onChatAboutTicket?: (issue: IssueWithStatus) => void;
  /** Multi-ticket navigation trail (#383). Rendered as a breadcrumb strip in the header. */
  trail?: TicketTrailControls;
}

/** The subset of `useTicketTrail` the panel needs to render & drive its trail strip. */
export interface TicketTrailControls {
  entries: TrailEntry[];
  activeId: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
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
  onViewInGraph,
  onChatAboutTicket,
  trail,
}: IssueDetailPanelProps) {
  const {
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
  } = useIssueEditForm(issue, onUpdate);
  const {
    workspaceCount,
    issueTags, setIssueTags,
    allTags, setAllTags,
    dependencies, setDependencies,
    availableIssues,
    availableSkills,
    comments, setComments,
    artifacts, setArtifacts,
    artifactsLoading,
    expandedArtifactId, setExpandedArtifactId,
    deletingArtifactId, setDeletingArtifactId,
    activityEvents,
    activityLoading,
    milestones,
    activeShowdownId, setActiveShowdownId,
    descriptionFetching,
  } = useIssueDetailData(issue, onIssueUpdate);
  const {
    mode: panelMode,
    setMode: setPanelMode,
    cycleMode: cyclePanelMode,
    sidebarWidth,
    startResize,
    resizing,
  } = usePanelLayout({
    storageKey: "issueDetail",
    modes: ["sidebar", "modal", "fullscreen"],
    defaultWidth: 560,
    minWidth: 360,
    maxWidth: 1100,
  });
  const [sidebarSide, setSidebarSide] = useState<"left" | "right">("right");
  const { dragPos, setDragPos, snapZone, wasDraggingRef, handleHeaderMouseDown } = useModalDrag({
    panelMode,
    setPanelMode,
    setSidebarSide,
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [togglingVisualVerify, setTogglingVisualVerify] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [moveToDonePending, setMoveToDonePending] = useState<MoveToDonePending | null>(null);
  const [dependencyImpactPending, setDependencyImpactPending] = useState<DependencyImpactPending | null>(null);
  const [showDecomposeModal, setShowDecomposeModal] = useState(false);
  const [showShowdownDialog, setShowShowdownDialog] = useState(false);
  const [showCompareAttempts, setShowCompareAttempts] = useState(false);
  const [newNoteBody, setNewNoteBody] = useState("");
  const [submittingNote, setSubmittingNote] = useState(false);
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null);

  // Inline edit state (independent of the full edit form)
  const {
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
  } = useIssueInlineEdit(issue, onIssueUpdate, descriptionFetching);

  // (Description is now supplied by the detail-bundle fetch above — no separate
  // lazy-load round-trip.)

  // Sync local state when issue prop changes (stale data fix - F6)
  useEffect(() => {
    if (!editing) {
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
  }, [issue, editing]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (editing) {
          handleCancelEdit();
        } else {
          onClose();
        }
        return;
      }
      // Browser-like back/forward across the multi-ticket trail (#383). Skip
      // while editing so it can't yank you off a half-written description.
      if (!editing && trail && e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        if (e.key === "ArrowLeft") trail.onBack();
        else trail.onForward();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editing, hasChanges, issue, onClose, trail]);

  // Reset delete confirmation on outside click
  useEffect(() => {
    if (!confirmDelete) return;
    function handleClick(e: MouseEvent) {
      if ((e.target as HTMLElement).closest("[data-delete-issue-action]")) return;
      setConfirmDelete(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [confirmDelete]);

  const {
    handleQuickEstimate, handleTogglePinned, handleDuplicate,
    handleAppendTouchedFilesToDescription, handleCopyArtifact, handleOpenArtifact,
    handleDeleteArtifact, handleAddNote, handleDeleteComment, handleStatusChange,
    handleDelete, isVisualVerify, toggleVisualVerify,
  } = useIssueActions({
    issue, statuses, dependencies, allTags, issueTags, description, confirmDelete,
    duplicating, submittingNote, togglingVisualVerify, deletingArtifactId,
    deletingCommentId, newNoteBody, onUpdate, onDelete, onNavigateToIssue,
    copyIssueArtifactContent, openIssueArtifact,
    setAllTags, setArtifacts, setComments, setConfirmDelete, setDeletingArtifactId,
    setDeletingCommentId, setDependencyImpactPending, setDescription, setDuplicating,
    setEditing, setExpandedArtifactId, setIssueTags, setMoveToDonePending,
    setNewNoteBody, setSaving, setSubmittingNote, setTogglingVisualVerify,
  });

  function handleBackdropClick() {
    if (wasDraggingRef.current) return;
    if (editing && hasChanges) {
      if (!window.confirm("You have unsaved changes. Discard?")) return;
    }
    onClose();
  }

  const { issueType: issueTypeDisplay, issueTypeClassName: badgeColor } = useIssueDisplayData(issue);

  // Panel positioning: fullscreen fills the viewport; modal centers (unless dragged);
  // sidebar pins to a side (or floats when dragged). Hoisted out of the JSX so the
  // container element stays readable.
  const panelPositionClass =
    panelMode === "fullscreen"
      ? "inset-0"
      : panelMode === "modal"
      ? `w-[min(1200px,96vw)] h-[90vh] rounded-lg border border-gray-200 dark:border-gray-700${dragPos ? "" : " top-[5vh] left-1/2 -translate-x-1/2"}`
      : sidebarSide === "left"
      ? "left-0 top-0 h-full border-r border-gray-200 dark:border-gray-700"
      : "right-0 top-0 h-full border-l border-gray-200 dark:border-gray-700";
  const panelPositionStyle: React.CSSProperties | undefined =
    dragPos && panelMode === "modal"
      ? { position: "fixed", left: dragPos.x, top: dragPos.y, transform: "none" }
      : panelMode === "sidebar" && dragPos
      ? { right: "auto", left: dragPos.x, top: dragPos.y, height: "min(90vh, 100vh)", width: `min(${sidebarWidth}px, 100vw)` }
      : panelMode === "sidebar"
      ? { width: `min(${sidebarWidth}px, 100vw)` }
      : undefined;

  return (
    <>
      {/* Snap zone indicators shown while dragging */}
      {snapZone === "left" && (
        <div style={{ width: `min(${sidebarWidth}px, 100vw)` }} className="fixed left-0 top-0 h-full z-40 bg-brand-500/20 border-r-2 border-brand-400 pointer-events-none transition-opacity" />
      )}
      {snapZone === "right" && (
        <div style={{ width: `min(${sidebarWidth}px, 100vw)` }} className="fixed right-0 top-0 h-full z-40 bg-brand-500/20 border-l-2 border-brand-400 pointer-events-none transition-opacity" />
      )}
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 z-40"
        onClick={handleBackdropClick}
      />
      {/* Panel */}
      <div
        data-panel
        className={`fixed bg-surface-raised dark:bg-surface-raised-dark shadow-xl z-50 flex flex-col animate-slide-in-right ${resizing ? "select-none" : ""} ${panelPositionClass}`}
        style={panelPositionStyle}
      >
        {/* Resize handle — only in sidebar mode, on the panel's inner edge */}
        {panelMode === "sidebar" && (
          <div
            onMouseDown={(e) => startResize(e, sidebarSide)}
            title="Drag to resize"
            className={`absolute top-0 bottom-0 ${sidebarSide === "right" ? "left-0 -ml-1" : "right-0 -mr-1"} w-2 cursor-col-resize z-10 group`}
          >
            <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-transparent group-hover:bg-brand-400 transition-colors" />
          </div>
        )}
        <IssueDetailHeader
          issue={issue}
          editing={editing}
          saving={saving}
          title={title}
          panelMode={panelMode}
          isVisualVerify={isVisualVerify}
          togglingVisualVerify={togglingVisualVerify}
          duplicating={duplicating}
          confirmDelete={confirmDelete}
          canDecompose={canDecomposeIssue(issue.description, issueTags)}
          onHeaderMouseDown={handleHeaderMouseDown}
          onSave={handleSave}
          onCancelEdit={handleCancelEdit}
          onStartEditing={() => setEditing(true)}
          onChat={onChatAboutTicket ? () => onChatAboutTicket(issue) : undefined}
          onToggleVisualVerify={toggleVisualVerify}
          onTogglePinned={handleTogglePinned}
          onDecompose={() => setShowDecomposeModal(true)}
          onDuplicate={handleDuplicate}
          onDelete={() => handleDelete()}
          onCyclePanelMode={() => {
            if (panelMode === "fullscreen") setSidebarSide("right");
            cyclePanelMode();
            setDragPos(null);
          }}
          onClose={handleBackdropClick}
        />

        {trail && (
          <TicketTrailStrip
            entries={trail.entries}
            activeId={trail.activeId}
            canGoBack={trail.canGoBack}
            canGoForward={trail.canGoForward}
            onBack={trail.onBack}
            onForward={trail.onForward}
            onSelect={trail.onSelect}
            onRemove={trail.onRemove}
          />
        )}

        <div
          className={`flex-1 overflow-y-auto p-4 space-y-4 ${
            panelMode === "sidebar"
              ? ""
              : "xl:space-y-0 xl:[column-width:34rem] xl:[column-gap:1rem] xl:[&>*]:[break-inside:avoid] xl:[&>*]:mb-4"
          }`}
        >
          {/* Blocked banner — shown when issue has unresolved blocking dependencies */}
          <IssueBlockedBanner dependencies={dependencies.dependencies} issueId={issue.id} />

          {/* Title - always visible, editable in edit mode or via inline click */}
          <div>
            {editing ? (
              <>
                <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-1">
                  Title
                </label>
                <input
                  type="text"
                  aria-label="Issue title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </>
            ) : inlineEditingTitle ? (
              <input
                ref={inlineTitleRef}
                type="text"
                aria-label="Issue title"
                value={inlineTitleValue}
                onChange={(e) => setInlineTitleValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void handleInlineTitleSave(); }
                  if (e.key === "Escape") { e.stopPropagation(); setInlineEditingTitle(false); setInlineTitleValue(issue.title); setInlineError(null); }
                }}
                onBlur={handleInlineTitleSave}
                disabled={inlineSaving === "title"}
                className="w-full text-base font-medium border border-brand-400 dark:border-brand-500 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 disabled:opacity-60"
              />
            ) : (
              <h3
                className="text-base font-medium text-gray-900 dark:text-gray-100 cursor-text hover:bg-gray-50 dark:hover:bg-gray-800 rounded px-1 -mx-1 py-0.5 transition-colors"
                title="Click to edit title"
                onClick={() => { setInlineTitleValue(issue.title); setInlineEditingTitle(true); }}
              >
                {issue.title}
              </h3>
            )}
          </div>

          {/* Non-blocking inline save error */}
          {inlineError && (
            <div className="flex items-center justify-between gap-2 text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded px-2.5 py-1.5">
              <span>{inlineError}</span>
              <button type="button" onClick={() => setInlineError(null)} className="shrink-0 text-red-500 hover:text-red-700">&times;</button>
            </div>
          )}

          {/* Description - always visible, editable in edit mode */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
                Description
              </label>
              {!editing && !inlineEditingDescription && (
                <button
                  type="button"
                  onClick={() => { setInlineDescriptionValue(issue.description ?? ""); setInlineEditingDescription(true); }}
                  className="text-xs text-gray-400 dark:text-gray-500 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
                  title="Edit description inline"
                >
                  Edit
                </button>
              )}
              {editing && (
                <div className="flex border border-gray-300 dark:border-gray-600 rounded overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setDescriptionMode("edit")}
                    className={`text-xs px-2 py-0.5 ${descriptionMode === "edit" ? "bg-brand-600 text-white" : "bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"}`}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setDescriptionMode("preview")}
                    className={`text-xs px-2 py-0.5 border-l border-gray-300 dark:border-gray-600 ${descriptionMode === "preview" ? "bg-brand-600 text-white" : "bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"}`}
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
                    <ReactMarkdown>{normalizeMarkdown(description)}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 dark:text-gray-500 italic min-h-[6rem] border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5">Nothing to preview.</p>
                )
              ) : (
              <>
              <MarkdownToolbar textareaRef={descriptionRef} value={description} onChange={setDescription} />
              <textarea
                ref={descriptionRef}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={panelMode !== "sidebar" ? 16 : 10}
                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-b rounded-t-none px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none"
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
            ) : inlineEditingDescription ? (
              <div>
                <textarea
                  ref={inlineDescriptionRef}
                  value={inlineDescriptionValue}
                  onChange={(e) => setInlineDescriptionValue(e.target.value)}
                  rows={panelMode !== "sidebar" ? 16 : 10}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") { e.stopPropagation(); setInlineEditingDescription(false); setInlineDescriptionValue(issue.description ?? ""); setInlineError(null); }
                  }}
                  disabled={inlineSaving === "description"}
                  className="w-full text-sm border border-brand-400 dark:border-brand-500 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 disabled:opacity-60"
                  placeholder="Add a description..."
                />
                <div className="flex items-center gap-2 mt-1.5">
                  <button
                    type="button"
                    onClick={handleInlineDescriptionSave}
                    disabled={inlineSaving === "description"}
                    className="text-xs font-medium bg-brand-600 text-white px-2.5 py-1 rounded hover:bg-brand-700 disabled:opacity-50 transition-colors"
                  >
                    {inlineSaving === "description" ? "Saving..." : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setInlineEditingDescription(false); setInlineDescriptionValue(issue.description ?? ""); setInlineError(null); }}
                    className="text-xs font-medium text-gray-500 dark:text-gray-400 px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  >
                    Cancel
                  </button>
                  <span className="text-xs text-gray-400 dark:text-gray-500">Esc to cancel</span>
                </div>
              </div>
            ) : issue.description ? (
              <div className="markdown-body">
                <ReactMarkdown>{normalizeMarkdown(issue.description)}</ReactMarkdown>
              </div>
            ) : descriptionFetching ? (
              <p className="text-sm text-gray-400 dark:text-gray-500 italic animate-pulse">
                Loading description…
              </p>
            ) : (
              <p className="text-sm text-gray-400 dark:text-gray-500 italic">
                No description. Click edit to add one.
              </p>
            )}
          </div>

          <IssueMetadataGrid
            editing={editing}
            issue={issue}
            statuses={statuses}
            issueType={issueType}
            setIssueType={setIssueType}
            estimate={estimate}
            setEstimate={setEstimate}
            dueDate={dueDate}
            setDueDate={setDueDate}
            externalKey={externalKey}
            setExternalKey={setExternalKey}
            externalUrl={externalUrl}
            setExternalUrl={setExternalUrl}
            skipAutoReview={skipAutoReview}
            setSkipAutoReview={setSkipAutoReview}
            milestoneId={milestoneId}
            setMilestoneId={setMilestoneId}
            milestones={milestones}
            estimating={estimating}
            handleStatusChange={handleStatusChange}
            handleQuickEstimate={handleQuickEstimate}
            handleAiEstimate={handleAiEstimate}
            badgeColor={badgeColor}
            issueTypeDisplay={issueTypeDisplay}
          />

          {/* Cycle time badge — only shown in view mode */}
          {!editing && <IssueCycleTimeBadge issueId={issue.id} />}

          {/* Work log section — only shown in view mode */}
          {!editing && <IssueWorkLogSection issueId={issue.id} />}

          {/* Workspaces section — placed directly below status/metadata for contextual proximity */}
          {!editing && (
            <IssueWorkspacesSection
              issue={issue}
              workspaceCount={workspaceCount}
              onManageWorkspaces={onManageWorkspaces}
              onStartWorkspace={onStartWorkspace}
              onIssueUpdate={onIssueUpdate}
              onShowCompareAttempts={() => setShowCompareAttempts(true)}
              onShowShowdown={() => setShowShowdownDialog(true)}
            />
          )}

          {/* ── Secondary detail sections ── */}
          <IssueSecondaryDetails
            issue={issue}
            editing={editing}
            issueTags={issueTags}
            setIssueTags={setIssueTags}
            allTags={allTags}
            dependencies={dependencies}
            setDependencies={setDependencies}
            availableIssues={availableIssues}
            onIssueUpdate={onIssueUpdate}
            onNavigateToIssue={onNavigateToIssue}
            onViewInGraph={onViewInGraph}
            onAppendTouchedFiles={handleAppendTouchedFilesToDescription}
            artifacts={artifacts}
            artifactsLoading={artifactsLoading}
            expandedArtifactId={expandedArtifactId}
            deletingArtifactId={deletingArtifactId}
            onOpenArtifact={handleOpenArtifact}
            onCopyArtifact={handleCopyArtifact}
            onDeleteArtifact={handleDeleteArtifact}
            activityEvents={activityEvents}
            activityLoading={activityLoading}
            onManageWorkspaces={onManageWorkspaces}
            comments={comments}
            newNoteBody={newNoteBody}
            submittingNote={submittingNote}
            deletingCommentId={deletingCommentId}
            onDeleteComment={handleDeleteComment}
            onAddNote={handleAddNote}
            onNewNoteBodyChange={setNewNoteBody}
          />
        </div>

        {/* Edit mode actions — shown in footer when editing */}
        {editing && (
          <IssueEditFooter
            title={title}
            saving={saving}
            enhancing={enhancing}
            preEnhanceSnapshot={preEnhanceSnapshot}
            onSave={handleSave}
            onCancel={handleCancelEdit}
            onEnhance={handleEnhance}
            onUndoEnhance={handleUndoEnhance}
          />
        )}
      </div>
      <IssueDetailDialogs
        issue={issue}
        statuses={statuses}
        dependencies={dependencies}
        availableSkills={availableSkills}
        moveToDonePending={moveToDonePending}
        setMoveToDonePending={setMoveToDonePending}
        dependencyImpactPending={dependencyImpactPending}
        setDependencyImpactPending={setDependencyImpactPending}
        showDecomposeModal={showDecomposeModal}
        setShowDecomposeModal={setShowDecomposeModal}
        showShowdownDialog={showShowdownDialog}
        setShowShowdownDialog={setShowShowdownDialog}
        activeShowdownId={activeShowdownId}
        setActiveShowdownId={setActiveShowdownId}
        showCompareAttempts={showCompareAttempts}
        setShowCompareAttempts={setShowCompareAttempts}
        onIssueUpdate={onIssueUpdate}
        onManageWorkspaces={onManageWorkspaces}
      />
    </>
  );
}
