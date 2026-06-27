import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { MoveToDonePending, DependencyImpactPending } from "../components/IssueDetailDialogs.js";

/** Panel-local UI/action/dialog state for IssueDetailPanel — the transient flags
 *  that coordinate the header actions (delete confirm, visual-verify toggle,
 *  duplicate), the modal dialogs (decompose / showdown / compare-attempts /
 *  move-to-done / dependency-impact) and the inline note composer. Extracted
 *  verbatim from IssueDetailPanel; the setters are threaded into useIssueActions
 *  which drives most of these transitions. */
export interface IssueDetailUiState {
  confirmDelete: boolean;
  setConfirmDelete: Dispatch<SetStateAction<boolean>>;
  togglingVisualVerify: boolean;
  setTogglingVisualVerify: Dispatch<SetStateAction<boolean>>;
  duplicating: boolean;
  setDuplicating: Dispatch<SetStateAction<boolean>>;
  moveToDonePending: MoveToDonePending | null;
  setMoveToDonePending: Dispatch<SetStateAction<MoveToDonePending | null>>;
  dependencyImpactPending: DependencyImpactPending | null;
  setDependencyImpactPending: Dispatch<SetStateAction<DependencyImpactPending | null>>;
  showDecomposeModal: boolean;
  setShowDecomposeModal: Dispatch<SetStateAction<boolean>>;
  showShowdownDialog: boolean;
  setShowShowdownDialog: Dispatch<SetStateAction<boolean>>;
  showCompareAttempts: boolean;
  setShowCompareAttempts: Dispatch<SetStateAction<boolean>>;
  newNoteBody: string;
  setNewNoteBody: Dispatch<SetStateAction<string>>;
  submittingNote: boolean;
  setSubmittingNote: Dispatch<SetStateAction<boolean>>;
  deletingCommentId: string | null;
  setDeletingCommentId: Dispatch<SetStateAction<string | null>>;
}

export function useIssueDetailUiState(): IssueDetailUiState {
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

  return {
    confirmDelete, setConfirmDelete,
    togglingVisualVerify, setTogglingVisualVerify,
    duplicating, setDuplicating,
    moveToDonePending, setMoveToDonePending,
    dependencyImpactPending, setDependencyImpactPending,
    showDecomposeModal, setShowDecomposeModal,
    showShowdownDialog, setShowShowdownDialog,
    showCompareAttempts, setShowCompareAttempts,
    newNoteBody, setNewNoteBody,
    submittingNote, setSubmittingNote,
    deletingCommentId, setDeletingCommentId,
  };
}
