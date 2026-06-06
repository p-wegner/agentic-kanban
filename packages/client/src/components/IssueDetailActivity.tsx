import React from "react";
import type { IssueArtifact, IssueWithStatus } from "@agentic-kanban/shared";
import type { ActivityEvent } from "./IssueActivitySection.js";
import { StatusTransitionTimeline } from "./StatusTransitionTimeline.js";
import { IssueActivitySection } from "./IssueActivitySection.js";
import { WorkspaceArtifactsBrowser } from "./WorkspaceArtifactsBrowser.js";
import {
  IssueArtifactsSection,
} from "./IssueDetailPanel.js";

export interface IssueDetailActivityProps {
  issue: IssueWithStatus;
  artifacts: IssueArtifact[];
  artifactsLoading: boolean;
  expandedArtifactId: string | null;
  deletingArtifactId: string | null;
  activityEvents: ActivityEvent[];
  activityLoading: boolean;
  onOpenArtifact: (artifact: IssueArtifact) => void;
  onCopyArtifact: (artifact: IssueArtifact) => void;
  onDeleteArtifact: (artifact: IssueArtifact) => void;
}

export function IssueDetailActivity({
  issue,
  artifacts,
  artifactsLoading,
  expandedArtifactId,
  deletingArtifactId,
  activityEvents,
  activityLoading,
  onOpenArtifact,
  onCopyArtifact,
  onDeleteArtifact,
}: IssueDetailActivityProps) {
  return (
    <>
      {/* Artifacts section */}
      <IssueArtifactsSection
        artifacts={artifacts}
        loading={artifactsLoading}
        expandedArtifactId={expandedArtifactId}
        deletingArtifactId={deletingArtifactId}
        onOpen={onOpenArtifact}
        onCopy={onCopyArtifact}
        onDelete={onDeleteArtifact}
      />

      {/* Status transition timeline */}
      <StatusTransitionTimeline
        events={activityEvents}
        loading={activityLoading}
        currentStatusName={issue.statusName}
      />

      {/* Activity feed */}
      <IssueActivitySection events={activityEvents} loading={activityLoading} />

      {/* Workspace Files section — browses the latest workspace's working directory */}
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
    </>
  );
}
