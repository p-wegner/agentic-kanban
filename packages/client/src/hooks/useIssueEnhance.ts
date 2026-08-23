import { useState } from "react";
import { apiPost } from "../lib/api.js";
import { showToast } from "../lib/toast.js";

interface IssueEnhanceTarget {
  projectId: string;
  title: string;
  description: string;
  setTitle: (value: string) => void;
  setDescription: (value: string) => void;
}

export interface IssueEnhanceControls {
  enhancing: boolean;
  /** Non-null once an enhancement has replaced the text — drives the Undo control. */
  preEnhanceSnapshot: { title: string; description: string } | null;
  enhance: () => Promise<void>;
  undoEnhance: () => void;
  /**
   * Drop a pending Undo without restoring the text. The edit form needs it (cancelling an
   * edit resets the fields from the issue, so a stale snapshot would offer to "undo" back
   * into the abandoned draft); the create forms unmount instead and never call it.
   */
  clearSnapshot: () => void;
}

/**
 * "Enhance with AI" for a create-issue form: POST the current title/description to
 * `/api/issues/enhance`, swap in the result, and keep a one-step undo snapshot.
 *
 * #772 — `CreateIssuePanel` and `CreateIssueForm` each carried a byte-identical copy of
 * this (the request, the snapshot bookkeeping, the failure toast, the `finally` reset).
 * The two forms are otherwise deliberately different shells; this is the part that was
 * genuinely one behaviour written twice.
 *
 * #810 — `useIssueEditForm` (behind `IssueDetailPanel`) held the same behaviour a THIRD
 * time, identical but for `projectId: issue.projectId` at the call and one extra reset in
 * its cancel-edit path. That reset is now `clearSnapshot` below rather than a reason to
 * keep a third copy.
 */
export function useIssueEnhance({
  projectId,
  title,
  description,
  setTitle,
  setDescription,
}: IssueEnhanceTarget): IssueEnhanceControls {
  const [enhancing, setEnhancing] = useState(false);
  const [preEnhanceSnapshot, setPreEnhanceSnapshot] = useState<{ title: string; description: string } | null>(null);

  async function enhance() {
    if (!title.trim() || enhancing) return;
    setEnhancing(true);
    try {
      setPreEnhanceSnapshot({ title, description });
      const result = await apiPost<{ title: string; description: string }>("/api/issues/enhance", { title, description, projectId });
      setTitle(result.title);
      setDescription(result.description);
    } catch (err) {
      setPreEnhanceSnapshot(null);
      showToast(err instanceof Error ? err.message : "Enhancement failed", "error");
    } finally {
      setEnhancing(false);
    }
  }

  function undoEnhance() {
    if (!preEnhanceSnapshot) return;
    setTitle(preEnhanceSnapshot.title);
    setDescription(preEnhanceSnapshot.description);
    setPreEnhanceSnapshot(null);
  }

  function clearSnapshot() {
    setPreEnhanceSnapshot(null);
  }

  return { enhancing, preEnhanceSnapshot, enhance, undoEnhance, clearSnapshot };
}
