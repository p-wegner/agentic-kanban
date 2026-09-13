import { useCallback, useState } from "react";
import type { DecomposableIssue, DrivePlanResult } from "@agentic-kanban/shared";
import { apiPost, apiPut } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { BRAND } from "../lib/chartColors.js";
import { EpicDecomposerModal, type DecomposeProposal } from "./EpicDecomposerModal.js";
import { useApiResource } from "../hooks/useApiResource.js";

interface PickerIssue {
  id: string;
  issueNumber: number | null;
  title: string;
}

/**
 * The empty half of the Drive Dashboard's tier graph, and the two actions that fill it
 * (#1072, #1071).
 *
 * A drive's scope IS its meta/epic issue's children, so a drive started from a target sentence
 * alone had none and no way to acquire one — the dashboard told the operator to "link a
 * meta/epic issue with children to this drive", an action the board offered nowhere.
 *
 * Two ways to get scope, offered side by side: **plan** it (`/plan` is idempotent — it seeds
 * the epic from the target when there is none and returns the existing one when there is, and
 * either way the ordinary `EpicDecomposerModal` runs the reviewed propose->confirm that creates
 * the children), or **attach an existing epic issue** (`PUT .../drives/:id` with `metaIssueId`)
 * for when the scope already exists as a ticket elsewhere on the board. Attaching still leaves
 * the epic's own children to be created/confirmed the normal way if it has none yet — this only
 * fixes the "no way to link one" dead end, it is not a second decomposition path.
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
  // #1133: when `/plan?decompose=1` returns a proposal alongside the epic, the modal opens
  // straight at the reviewable preview instead of behind a second "Generate Decomposition"
  // click. Absent (undefined) when the endpoint made no model call (failed decomposition,
  // or the caller didn't ask) — `EpicDecomposerModal` falls back to its own fetch-on-demand.
  const [initialProposal, setInitialProposal] = useState<DecomposeProposal | undefined>(undefined);
  const [planning, setPlanning] = useState(false);
  const [selectedIssueId, setSelectedIssueId] = useState("");
  const [attaching, setAttaching] = useState(false);

  const { data: issues } = useApiResource<PickerIssue[]>(
    hasMetaIssue ? null : `/api/issues?projectId=${projectId}&slim=1`,
  );

  const plan = useCallback(async () => {
    if (planning) return;
    setPlanning(true);
    try {
      // The wire contract is `DrivePlanResult` (`proposal?: DrivePlanProposal`); typed here
      // with the client's own `DecomposeProposal` for `proposal` instead, since that is the
      // shape `EpicDecomposerModal` already renders (its `priority` union carries the
      // client-normalized `"critical"`, not the server's pre-normalization `"urgent"`).
      const result = await apiPost<Omit<DrivePlanResult, "proposal"> & { proposal?: DecomposeProposal }>(
        `/api/projects/${projectId}/drives/${driveId}/plan?decompose=1`,
        {},
      );
      setInitialProposal(result.proposal);
      setEpic(result.issue);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to plan drive", "error");
    } finally {
      setPlanning(false);
    }
  }, [projectId, driveId, planning]);

  const attach = useCallback(async () => {
    if (attaching || !selectedIssueId) return;
    setAttaching(true);
    try {
      await apiPut(`/api/projects/${projectId}/drives/${driveId}`, { metaIssueId: selectedIssueId });
      showToast("Epic attached to drive", "success");
      onScoped();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to attach epic", "error");
    } finally {
      setAttaching(false);
    }
  }, [projectId, driveId, selectedIssueId, attaching, onScoped]);

  const handleConfirmed = useCallback(() => {
    setEpic(null);
    setInitialProposal(undefined);
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

      {!hasMetaIssue && (
        <>
          <div className="flex items-center gap-2 w-full max-w-sm text-xs text-gray-400 dark:text-gray-500">
            <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
            or
            <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
          </div>
          <label className="flex flex-col gap-1 w-full max-w-sm text-left">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
              Attach an existing epic issue
            </span>
            <select
              value={selectedIssueId}
              onChange={(e) => setSelectedIssueId(e.target.value)}
              className="px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100"
            >
              <option value="">— choose an issue —</option>
              {(issues ?? []).map((i) => (
                <option key={i.id} value={i.id}>
                  {i.issueNumber != null ? `#${i.issueNumber} ` : ""}
                  {i.title}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={attach}
            disabled={attaching || !selectedIssueId}
            className="px-3 py-1.5 text-sm rounded-md font-medium border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800/40 disabled:opacity-50"
          >
            {attaching ? "Attaching…" : "Attach epic"}
          </button>
        </>
      )}

      {epic && (
        <EpicDecomposerModal
          issue={epic}
          initialProposal={initialProposal}
          onClose={() => { setEpic(null); setInitialProposal(undefined); }}
          onConfirmed={handleConfirmed}
        />
      )}
    </div>
  );
}
