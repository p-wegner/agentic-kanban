// Modal/dialog cluster for IssueDetailPanel (extracted to shrink the panel's
// god-render). These are the boolean/nullable-state–gated overlays that render
// as siblings after the panel body. Kept as a cohesive, properly-typed unit so
// each modal's wiring lives in one place and the container only owns the state.
import type { Dispatch, SetStateAction } from "react";
import type { IssueWithStatus, DependencyInfo, ShowdownResponse } from "@agentic-kanban/shared";
import { MoveToDoneDialog } from "./MoveToDoneDialog.js";
import { DependencyImpactDialog } from "./DependencyImpactDialog.js";
import { EpicDecomposerModal } from "./EpicDecomposerModal.js";
import { ShowdownDialog } from "./ShowdownDialog.js";
import { ShowdownPanel } from "./ShowdownPanel.js";
import { CompareAttemptsPanel } from "./CompareAttemptsPanel.js";

/** A pending "move to Done" confirmation: just the confirm thunk to run on OK. */
export interface MoveToDonePending {
  confirm: () => Promise<void>;
}

/** A pending status change whose dependency impact must be confirmed first. */
export interface DependencyImpactPending {
  toStatusId: string;
  toStatusName: string;
  confirm: () => Promise<void>;
}

interface IssueDetailDialogsProps {
  issue: IssueWithStatus;
  statuses: { id: string; name: string }[];
  dependencies: DependencyInfo;
  availableSkills: { id: string; name: string; description: string }[];
  moveToDonePending: MoveToDonePending | null;
  setMoveToDonePending: Dispatch<SetStateAction<MoveToDonePending | null>>;
  dependencyImpactPending: DependencyImpactPending | null;
  setDependencyImpactPending: Dispatch<SetStateAction<DependencyImpactPending | null>>;
  showDecomposeModal: boolean;
  setShowDecomposeModal: Dispatch<SetStateAction<boolean>>;
  showShowdownDialog: boolean;
  setShowShowdownDialog: Dispatch<SetStateAction<boolean>>;
  activeShowdownId: string | null;
  setActiveShowdownId: Dispatch<SetStateAction<string | null>>;
  showCompareAttempts: boolean;
  setShowCompareAttempts: Dispatch<SetStateAction<boolean>>;
  onIssueUpdate: (issue: IssueWithStatus) => void;
  onManageWorkspaces: (issue: IssueWithStatus, workspaceId?: string, sessionId?: string) => void;
}

export function IssueDetailDialogs({
  issue,
  statuses,
  dependencies,
  availableSkills,
  moveToDonePending,
  setMoveToDonePending,
  dependencyImpactPending,
  setDependencyImpactPending,
  showDecomposeModal,
  setShowDecomposeModal,
  showShowdownDialog,
  setShowShowdownDialog,
  activeShowdownId,
  setActiveShowdownId,
  showCompareAttempts,
  setShowCompareAttempts,
  onIssueUpdate,
  onManageWorkspaces,
}: IssueDetailDialogsProps) {
  return (
    <>
      {moveToDonePending && (
        <MoveToDoneDialog
          issue={issue}
          onConfirm={moveToDonePending.confirm}
          onCancel={() => setMoveToDonePending(null)}
        />
      )}
      {dependencyImpactPending && (
        <DependencyImpactDialog
          issueId={issue.id}
          fromStatusName={statuses.find((s) => s.id === issue.statusId)?.name ?? ""}
          toStatusName={dependencyImpactPending.toStatusName}
          dependencies={dependencies.dependencies}
          onConfirm={dependencyImpactPending.confirm}
          onCancel={() => setDependencyImpactPending(null)}
        />
      )}
      {showDecomposeModal && (
        <EpicDecomposerModal
          issue={issue}
          onClose={() => setShowDecomposeModal(false)}
          onConfirmed={() => {
            setShowDecomposeModal(false);
            onIssueUpdate(issue);
          }}
        />
      )}
      {showShowdownDialog && (
        <ShowdownDialog
          issue={issue}
          skills={availableSkills}
          onCreated={(sd: ShowdownResponse) => {
            setShowShowdownDialog(false);
            setActiveShowdownId(sd.id);
          }}
          onCancel={() => setShowShowdownDialog(false)}
        />
      )}
      {activeShowdownId && (
        <ShowdownPanel
          showdownId={activeShowdownId}
          onClose={() => setActiveShowdownId(null)}
          onWinnerPicked={() => setActiveShowdownId(null)}
        />
      )}
      {showCompareAttempts && (
        <CompareAttemptsPanel
          issueId={issue.id}
          onClose={() => setShowCompareAttempts(false)}
          onOpenWorkspace={(workspaceId) => onManageWorkspaces(issue, workspaceId)}
        />
      )}
    </>
  );
}
