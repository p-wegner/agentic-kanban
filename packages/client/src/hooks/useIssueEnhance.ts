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
}

/**
 * "Enhance with AI" for a create-issue form: POST the current title/description to
 * `/api/issues/enhance`, swap in the result, and keep a one-step undo snapshot.
 *
 * #772 — `CreateIssuePanel` and `CreateIssueForm` each carried a byte-identical copy of
 * this (the request, the snapshot bookkeeping, the failure toast, the `finally` reset).
 * The two forms are otherwise deliberately different shells; this is the part that was
 * genuinely one behaviour written twice.
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

  return { enhancing, preEnhanceSnapshot, enhance, undoEnhance };
}
