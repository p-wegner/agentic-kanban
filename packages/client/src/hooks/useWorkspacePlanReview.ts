import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";

/** Per-workspace plan-review inline-edit state for WorkspacePanel: the fetched
 *  plan contents plus the implement/reject editing toggles and draft text, all
 *  keyed by workspace id. `planContent` is hydrated by the panel's
 *  fetchWorkspaces; the edit/reject setters are threaded into useWorkspaceActions.
 *  Extracted verbatim from WorkspacePanel. */
export interface WorkspacePlanReview {
  planContent: Record<string, string | null>;
  setPlanContent: Dispatch<SetStateAction<Record<string, string | null>>>;
  planEditMode: Record<string, boolean>;
  setPlanEditMode: Dispatch<SetStateAction<Record<string, boolean>>>;
  planEditText: Record<string, string>;
  setPlanEditText: Dispatch<SetStateAction<Record<string, string>>>;
  rejectMode: Record<string, boolean>;
  setRejectMode: Dispatch<SetStateAction<Record<string, boolean>>>;
  rejectFeedback: Record<string, string>;
  setRejectFeedback: Dispatch<SetStateAction<Record<string, string>>>;
}

export function useWorkspacePlanReview(): WorkspacePlanReview {
  const [planContent, setPlanContent] = useState<Record<string, string | null>>({});
  const [planEditMode, setPlanEditMode] = useState<Record<string, boolean>>({});
  const [planEditText, setPlanEditText] = useState<Record<string, string>>({});
  const [rejectMode, setRejectMode] = useState<Record<string, boolean>>({});
  const [rejectFeedback, setRejectFeedback] = useState<Record<string, string>>({});

  return {
    planContent, setPlanContent,
    planEditMode, setPlanEditMode,
    planEditText, setPlanEditText,
    rejectMode, setRejectMode,
    rejectFeedback, setRejectFeedback,
  };
}
