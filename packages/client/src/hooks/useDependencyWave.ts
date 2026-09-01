// The Backlog view's dependency-wave concern: the plan fetch and the
// "start next wave" action, with its visual feedback (#972).
//
// Extracted from `BacklogView` when #972 added the feedback — the wave state was
// four `useState`s and two handlers inline in a component that is already on the
// function-nloc shrink-only ring, and the concern has no other coupling to the
// backlog list beyond the refresh trigger.
//
// The feedback itself is the point of the extraction being worth reading: a wave
// start is N ticket-workspace starts, and starting a SINGLE ticket has always
// marked its card via `pendingWorkspaceIssueIds` (spinner + "Setting up
// workspace…"). A wave marked nothing, so between the click and the toast the
// board looked idle while worktrees were being created. This hook drives the
// same store slice, plus a `progress` line the panel renders — the toast is
// transient, and "what did that click actually do" needs to outlive it.
import { useCallback, useEffect, useRef, useState } from "react";
import type { DependencyWavePlan, DependencyWaveStartResult } from "@agentic-kanban/shared";
import { apiPost } from "../lib/api.js";
import { useApiResource } from "./useApiResource.js";
import { showToast } from "../lib/toast.js";
import { boardBulkSelectionActions } from "../stores/boardBulkSelectionStore.js";
import type { WaveStartProgress } from "../lib/waveStartFeedback.js";
import {
  IDLE_WAVE_PROGRESS,
  clearWaveIssuesPending,
  describeWaveStartError,
  describeWaveStarting,
  markWaveIssuesPending,
  selectWaveStartCandidates,
  summarizeWaveStart,
} from "../lib/waveStartFeedback.js";

export interface DependencyWaveState {
  plan: DependencyWavePlan | null;
  loading: boolean;
  starting: boolean;
  progress: WaveStartProgress;
  refresh: () => void;
  startNextWave: () => Promise<void>;
}

/**
 * The plan fetch rides `useApiResource` — #513's endorsed replacement for a
 * hand-rolled data/loading/error ladder. That is not only convention here: the
 * inline version this replaced had no cancelled guard, so switching project
 * while a plan request was in flight could land the OLD project's wave plan.
 */
export function useDependencyWave(projectId: string, boardKey: string): DependencyWaveState {
  const resource = useApiResource<DependencyWavePlan>(
    `/api/projects/${projectId}/dependency-waves`,
    { fallbackError: "Failed to load the wave plan" },
  );
  const [starting, setStarting] = useState(false);
  const [progress, setProgress] = useState<WaveStartProgress>(IDLE_WAVE_PROGRESS);
  const { data: plan, loading, reload: refresh } = resource;

  // `BacklogView` is rendered without a `key`, so switching project changes
  // `projectId` on a MOUNTED component: the resource re-fetches (its path moved)
  // but this hook's own state does not reset by itself. `progress` is keyed to
  // the project that produced it — its message names that project's issue
  // numbers, and `attemptedIssueIds` badges cards by id — so carrying it across a
  // switch attributes one project's wave start to another's board. Clear it.
  const seenProjectId = useRef(projectId);
  if (seenProjectId.current !== projectId) {
    seenProjectId.current = projectId;
    // Render-phase reset (the sanctioned "adjust state on prop change" form):
    // the stale banner never reaches the DOM, where an effect would flash it.
    setProgress(IDLE_WAVE_PROGRESS);
  }

  // The plan is derived from the board's issues, so a board move invalidates it.
  // `useApiResource` re-fetches on path change only, and the path does not carry
  // the board's shape — hence the explicit reload. The initial mount is already
  // covered by the resource's own effect; skipping the first run of this one is
  // what keeps that from being a double fetch.
  //
  // The same applies to a project switch: the resource re-fetches on the path
  // change, so the new project's first `boardKey` must be absorbed rather than
  // reloaded, or every switch costs a duplicate request.
  const seenBoardKey = useRef<string | null>(null);
  const boardKeyProjectId = useRef(projectId);
  useEffect(() => {
    if (seenBoardKey.current === null || boardKeyProjectId.current !== projectId) {
      seenBoardKey.current = boardKey;
      boardKeyProjectId.current = projectId;
      return;
    }
    if (seenBoardKey.current === boardKey) return;
    seenBoardKey.current = boardKey;
    refresh();
  }, [boardKey, projectId, refresh]);

  const startNextWave = useCallback(async () => {
    // Mark the issues this click will attempt BEFORE the request goes out, so
    // their cards carry the badge for the whole worktree-creation + setup-script
    // wait rather than only after it.
    const candidateIds = selectWaveStartCandidates(plan);
    setStarting(true);
    setProgress(describeWaveStarting(candidateIds));
    boardBulkSelectionActions.setPendingWorkspaceIssueIds((prev) => markWaveIssuesPending(prev, candidateIds));
    try {
      const result = await apiPost<DependencyWaveStartResult>(
        `/api/projects/${projectId}/dependency-waves/start-next`,
      );
      const outcome = summarizeWaveStart(result, candidateIds);
      setProgress(outcome);
      // Nothing-to-start is not an error; only a real failure gets the error tone.
      showToast(outcome.message, outcome.failed ? "error" : "success");
      refresh();
    } catch (err) {
      const outcome = describeWaveStartError(err, candidateIds);
      setProgress(outcome);
      showToast(outcome.message, "error");
    } finally {
      setStarting(false);
      boardBulkSelectionActions.setPendingWorkspaceIssueIds((prev) => clearWaveIssuesPending(prev, candidateIds));
    }
  }, [plan, projectId, refresh]);

  return { plan, loading, starting, progress, refresh, startNextWave };
}
