import type { IssueWithStatus, DependencyInfo, IssueArtifact, MergedCommit } from "@agentic-kanban/shared";
import { apiPost, apiDelete } from "../lib/api.js";
import { showToast } from "./Toast.js";
import { formatRelativeTime, formatAbsoluteTime } from "../lib/formatRelativeTime.js";
import { invalidateAvailableIssuesCache } from "../hooks/useIssueDetailData.js";
import { IssueChecklistSection } from "./IssueChecklistSection.js";
import { DependencyDisplay } from "./DependencyDisplay.js";
import { IssueTouchedFilesSection, type TouchedFile } from "./IssueTouchedFilesSection.js";
import { IssueRelatedIssuesSection } from "./IssueRelatedIssuesSection.js";
import { IssueFollowUpSection } from "./IssueFollowUpSection.js";
import { IssueArtifactsSection } from "./IssueArtifactsSection.js";
import { StatusTransitionTimeline } from "./StatusTransitionTimeline.js";
import { IssueActivitySection, type ActivityEvent } from "./IssueActivitySection.js";
import { IssueMergedCommitsSection } from "./IssueMergedCommitsSection.js";
import { WorkspaceArtifactsBrowser } from "./WorkspaceArtifactsBrowser.js";
import { IssueDetailComments, type IssueComment } from "./IssueDetailComments.js";

type Tag = { id: string; name: string; color: string | null };

interface IssueSecondaryDetailsProps {
  issue: IssueWithStatus;
  editing: boolean;
  issueTags: Tag[];
  setIssueTags: React.Dispatch<React.SetStateAction<Tag[]>>;
  allTags: Tag[];
  dependencies: DependencyInfo;
  setDependencies: React.Dispatch<React.SetStateAction<DependencyInfo>>;
  availableIssues: IssueWithStatus[];
  onIssueUpdate: (issue: IssueWithStatus) => void;
  onNavigateToIssue?: (issueId: string) => void;
  onViewInGraph?: (issueId: string) => void;
  onAppendTouchedFiles: (files: TouchedFile[]) => void;
  artifacts: IssueArtifact[];
  artifactsLoading: boolean;
  expandedArtifactId: string | null;
  deletingArtifactId: string | null;
  onOpenArtifact: (artifact: IssueArtifact) => void;
  onCopyArtifact: (artifact: IssueArtifact) => void;
  onDeleteArtifact: (artifact: IssueArtifact) => void;
  activityEvents: ActivityEvent[];
  activityLoading: boolean;
  onManageWorkspaces: (issue: IssueWithStatus, workspaceId?: string, sessionId?: string) => void;
  comments: IssueComment[];
  newNoteBody: string;
  submittingNote: boolean;
  deletingCommentId: string | null;
  onDeleteComment: (commentId: string) => void;
  onAddNote: () => void;
  onNewNoteBodyChange: (body: string) => void;
}

/**
 * The stack of "secondary" sections below the main issue fields: tags, checklist,
 * dependencies, touched/related files, follow-up, artifacts, timeline, activity,
 * merged commits, workspace files, comments, timestamps. Extracted from
 * IssueDetailPanel — most of these are already their own components; this is the
 * composition wrapper plus the inline tags editor.
 */
export function IssueSecondaryDetails({
  issue,
  editing,
  issueTags,
  setIssueTags,
  allTags,
  dependencies,
  setDependencies,
  availableIssues,
  onIssueUpdate,
  onNavigateToIssue,
  onViewInGraph,
  onAppendTouchedFiles,
  artifacts,
  artifactsLoading,
  expandedArtifactId,
  deletingArtifactId,
  onOpenArtifact,
  onCopyArtifact,
  onDeleteArtifact,
  activityEvents,
  activityLoading,
  onManageWorkspaces,
  comments,
  newNoteBody,
  submittingNote,
  deletingCommentId,
  onDeleteComment,
  onAddNote,
  onNewNoteBodyChange,
}: IssueSecondaryDetailsProps) {
  return (
    <>
      {/* Tags section - visible in both view and edit mode */}
      <div className="border-t border-gray-100 dark:border-gray-800 pt-3">
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
                    await apiDelete(`/api/issues/${issue.id}/tags/${tag.id}`);
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
              className="text-xs border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
              value=""
              onChange={async (e) => {
                const tagId = e.target.value;
                if (!tagId) return;
                try {
                  await apiPost(`/api/issues/${issue.id}/tags`, { tagId });
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

      {/* Acceptance Criteria Checklist section */}
      <IssueChecklistSection issueId={issue.id} initialChecklist={issue.checklist} />

      {/* Dependencies section */}
      <DependencyDisplay
        issue={issue}
        dependencies={dependencies}
        setDependencies={setDependencies}
        availableIssues={availableIssues}
        onIssueUpdate={onIssueUpdate}
        onNavigateToIssue={onNavigateToIssue}
        onViewInGraph={onViewInGraph}
      />

      {/* Touched Files section */}
      <IssueTouchedFilesSection
        issueId={issue.id}
        onAppendToDescription={onAppendTouchedFiles}
      />

      {/* Related Issues section */}
      <IssueRelatedIssuesSection issueId={issue.id} onNavigateToIssue={onNavigateToIssue} />

      {/* Follow-up task creation */}
      <IssueFollowUpSection
        parentIssueId={issue.id}
        projectId={issue.projectId}
        onCreated={() => invalidateAvailableIssuesCache(issue.projectId)}
      />

      {!editing && (
        <IssueArtifactsSection
          artifacts={artifacts}
          loading={artifactsLoading}
          expandedArtifactId={expandedArtifactId}
          deletingArtifactId={deletingArtifactId}
          onOpen={onOpenArtifact}
          onCopy={onCopyArtifact}
          onDelete={onDeleteArtifact}
        />
      )}

      {/* Status transition timeline */}
      {!editing && (
        <StatusTransitionTimeline
          events={activityEvents}
          loading={activityLoading}
          currentStatusName={issue.statusName}
        />
      )}

      {/* Activity feed */}
      {!editing && (
        <IssueActivitySection
          events={activityEvents}
          loading={activityLoading}
          issueTitle={issue.title}
          issueNumber={issue.issueNumber}
          currentStatusName={issue.statusName}
        />
      )}

      {/* Merged commits that landed on the default branch for this issue */}
      {!editing && (
        <IssueMergedCommitsSection
          issueId={issue.id}
          onOpenDiff={(commit: MergedCommit) => onManageWorkspaces(issue, commit.workspaceId)}
        />
      )}

      {/* Workspace Files section — browses the latest workspace's working directory */}
      {!editing && (
        <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-2">
            Workspace Files
          </label>
          {issue.workspaceSummary?.main ? (
            <WorkspaceArtifactsBrowser workspaceId={issue.workspaceSummary.main.id} />
          ) : (
            <p className="text-xs text-gray-400 dark:text-gray-500">No workspace yet. Start a workspace to see generated files.</p>
          )}
        </div>
      )}

      {/* System comments + user discussion */}
      <IssueDetailComments
        issue={issue}
        editing={editing}
        comments={comments}
        newNoteBody={newNoteBody}
        submittingNote={submittingNote}
        deletingCommentId={deletingCommentId}
        onManageWorkspaces={onManageWorkspaces}
        onDeleteComment={onDeleteComment}
        onAddNote={onAddNote}
        onNewNoteBodyChange={onNewNoteBodyChange}
      />

      {/* Timestamps */}
      <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400 dark:text-gray-500">
          <span title={formatAbsoluteTime(issue.createdAt)}>Created {formatRelativeTime(issue.createdAt)}</span>
          <span title={formatAbsoluteTime(issue.updatedAt)}>Updated {formatRelativeTime(issue.updatedAt)}</span>
          {issue.statusChangedAt && (
            <span title={formatAbsoluteTime(issue.statusChangedAt)}>Moved to <span className="text-gray-500 dark:text-gray-400 font-medium">{issue.statusName}</span> {formatRelativeTime(issue.statusChangedAt)}</span>
          )}
        </div>
      </div>
    </>
  );
}
