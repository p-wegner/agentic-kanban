import { useCallback, useState } from "react";
import type { DecomposableIssue, DrivePlanResult } from "@agentic-kanban/shared";
import { apiPost } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { BRAND } from "../lib/chartColors.js";
import { EpicDecomposerModal } from "./EpicDecomposerModal.js";

/**
 * The empty half of the Drive Dashboard's tier graph, and the one action that fills it (#1072).
 *
 * A drive's scope IS its meta/epic issue's children, so a drive started from a target sentence
 * alone had none and no way to acquire one — the dashboard told the operator to "link a
 * meta/epic issue with children to this drive", an action the board offered nowhere.
 *
 * One button covers both dead ends, because `/plan` is idempotent: it seeds the epic from the
 * target when there is none and returns the existing one when there is, and either way the
 * ordinary `EpicDecomposerModal` runs the reviewed propose->confirm that creates the children.
 * Nothing here is a second way to fan out an epic.
 *
 * Split out of `DriveDashboard` rather than inlined: that component was already at the client's
 * 400-nloc ratchet, and this is a self-contained concern with its own state.
 */
export interface DriveScopePlannerProps {
  projectId: string;
  driveId: string;
  /** Whether the drive already has an epic — decides the wording, not the action. */
  hasMetaIssue: boolean;
  /** Called once children exist, so the dashboard can re-read its scope. */
  onScoped: () => void;
}

export function DriveScopePlanner({ projectId, driveId, hasMetaIssue, onScoped }: DriveScopePlannerProps) {
  const [epic, setEpic] = useState<DecomposableIssue | null>(null);
  const [planning, setPlanning] = useState(false);

  const plan = useCallback(async () => {
    if (planning) return;
    setPlanning(true);
    try {
      const result = await apiPost<DrivePlanResult>(
        `/api/projects/${projectId}/drives/${driveId}/plan`,
        {},
      );
      setEpic(result.issue);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to plan drive", "error");
    } finally {
      setPlanning(false);
    }
  }, [projectId, driveId, planning]);

  const handleConfirmed = useCallback(() => {
    setEpic(null);
    showToast("Drive scoped — the backlog is filled", "success");
    onScoped();
  }, [onScoped]);

  return (
    <div className="px-3 py-6 flex flex-col items-center gap-2 text-center">
      <span className="text-sm text-gray-400 dark:text-gray-500">
        {hasMetaIssue
          ? "This drive has an epic but no children yet."
          : "This drive has no scope yet — nothing to build."}
      </span>
      <button
        onClick={plan}
        disabled={planning}
        className="px-3 py-1.5 text-sm rounded-md font-medium text-white disabled:opacity-50"
        style={{ backgroundColor: BRAND }}
      >
        {planning ? "Planning…" : hasMetaIssue ? "Decompose the epic" : "Plan this drive"}
      </button>
      <span className="text-xs text-gray-400 dark:text-gray-500 max-w-md">
        Turns the target into an epic, then proposes its child tickets for review. The children
        you confirm become this drive&apos;s backlog.
      </span>
      {epic && (
        <EpicDecomposerModal issue={epic} onClose={() => setEpic(null)} onConfirmed={handleConfirmed} />
      )}
    </div>
  );
}
