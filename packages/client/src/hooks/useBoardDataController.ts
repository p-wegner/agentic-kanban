import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import { boardSelectionActions } from "../stores/boardSelectionStore.js";
import { createBoardColumnsStore } from "../lib/boardColumnsStore.js";
import {
  useActiveProjectPreferenceQuery,
  useArchivedProjectsQuery,
  useBoardQuery,
  useMilestonesQuery,
  useProjectsQuery,
  useSprintCapacityQuery,
  useTagsQuery,
} from "./useBoardDataQueries.js";

/** Stable empty columns so the derived value keeps referential identity between
 *  renders (memo deps downstream compare it by reference). */
const EMPTY_COLUMNS: StatusWithIssues[] = [];

/** localStorage key holding the last active projectId (same `kanban-*` naming as
 *  `kanban-board-view` / `kanban-swimlane`). Read synchronously at mount so the
 *  board query fires IN PARALLEL with /api/projects + /api/preferences/active-project
 *  instead of serializing behind them (cold-load time-to-columns was gated by
 *  /board firing last). */
export const LAST_ACTIVE_PROJECT_STORAGE_KEY = "kanban-last-active-project";

export function readLastActiveProjectId(): string | null {
  try {
    return localStorage.getItem(LAST_ACTIVE_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistLastActiveProjectId(id: string): void {
  try {
    localStorage.setItem(LAST_ACTIVE_PROJECT_STORAGE_KEY, id);
  } catch {
    // Storage unavailable (private mode / node tests) — the seed is only an optimization.
  }
}

/**
 * Which project should be active once /api/projects + the active-project
 * preference have both resolved. Pure so it is unit-testable.
 *
 * - No projects → none.
 * - A localStorage-seeded id is only OPTIMISTIC: the server's answer (preference,
 *   falling back to the first project) always reconciles it — normally they
 *   agree, so this is a no-op and the optimistically fetched board is reused.
 * - A non-seeded current selection (user already switched) is sticky, matching
 *   the pre-existing `current ?? nextId` behavior (#327).
 */
export function resolveNextActiveProjectId(params: {
  current: string | null;
  currentIsSeeded: boolean;
  projects: ReadonlyArray<{ id: string }>;
  preferredId: string | null | undefined;
}): string | null {
  const { current, currentIsSeeded, projects, preferredId } = params;
  if (projects.length === 0) return null;
  const nextId = preferredId && projects.some((p) => p.id === preferredId) ? preferredId : projects[0].id;
  if (currentIsSeeded) return nextId;
  return current ?? nextId;
}

interface UseBoardDataControllerParams {
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}

export function useBoardDataController({ setError }: UseBoardDataControllerParams) {
  const queryClient = useQueryClient();
  const [switchingProject, setSwitchingProject] = useState(false);
  // Seed synchronously from localStorage so useBoardQuery(projectId) mounts
  // enabled and /board loads in parallel with the projects/preference queries.
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(readLastActiveProjectId);
  // True while the seeded id is still unconfirmed by the server's answer; used
  // to (a) let the reconcile effect override the seed and (b) suppress a board
  // error from a stale stored id (deleted project) until reconciliation.
  const seededRef = useRef(activeProjectId !== null);
  const [seedPending, setSeedPending] = useState(activeProjectId !== null);
  const bootstrappedIssueParamRef = useRef(false);

  // Single-owner board columns: react-query's `board(projectId)` cache. The
  // legacy `columns` useState mirror and `columnsRef` mirror are gone (§3.5) —
  // `setColumns` / `columnsRef` are a thin facade over the query cache so every
  // consumer keeps its existing call shape while there is only one copy.
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  // One-shot write-suppression window, armed by the EXTERNAL setActiveProjectId
  // and cleared on the next render. Rationale: `handleProjectChange` calls
  // `setActiveProjectId(next)` and then `setColumns([])` in the same tick —
  // before re-render the store's project-id getter still resolves to the OLD
  // project, so that wipe used to erase the project being LEFT from the query
  // cache, guaranteeing a skeleton on every revisit. Suppressing store writes
  // inside the switch tick keeps the leaving project's cached board so a later
  // switch back renders it instantly while the ETag refetch revalidates.
  const suppressStoreWritesRef = useRef(false);
  suppressStoreWritesRef.current = false;
  const { setColumns, columnsRef } = useMemo(
    () =>
      createBoardColumnsStore(queryClient, () =>
        suppressStoreWritesRef.current ? null : activeProjectIdRef.current,
      ),
    [queryClient],
  );

  /** External setter (project switch / unregister / deep link): marks the seed
   *  as confirmed-obsolete and arms the switch-tick write suppression above. */
  const setActiveProjectId = useCallback((update: React.SetStateAction<string | null>) => {
    seededRef.current = false;
    setSeedPending(false);
    suppressStoreWritesRef.current = true;
    // The wipe happens synchronously in the same tick as the switch; disarm on
    // the next microtask (before any await continuation and before re-render can
    // be skipped by a same-id bailout) so no later legit write is dropped.
    queueMicrotask(() => {
      suppressStoreWritesRef.current = false;
    });
    setActiveProjectIdState(update);
  }, []);

  const projectsQuery = useProjectsQuery();
  // Deferred until the primary projects list has settled: the archived list is only
  // shown in the project menu, and fetching it in parallel at mount doubled the
  // cold-start load on the slowest endpoint (/api/projects).
  const archivedProjectsQuery = useArchivedProjectsQuery({ enabled: projectsQuery.isSuccess });
  const activeProjectPreferenceQuery = useActiveProjectPreferenceQuery();
  const boardQuery = useBoardQuery(activeProjectId);
  const sprintCapacityQuery = useSprintCapacityQuery(activeProjectId);
  const tagsQuery = useTagsQuery(activeProjectId);
  const milestonesQuery = useMilestonesQuery(activeProjectId);

  // `keepPreviousData` placeholder rows belong to the PREVIOUS project — mask
  // them so project A's board never renders under project B; real cached data
  // for the target project (cache hit on the new key) is NOT placeholder data
  // and renders immediately.
  const columns = boardQuery.isPlaceholderData ? EMPTY_COLUMNS : boardQuery.data ?? EMPTY_COLUMNS;
  const projects = projectsQuery.data ?? [];
  const archivedProjects = archivedProjectsQuery.data ?? [];
  const allTags = tagsQuery.data ?? [];
  const milestones = milestonesQuery.data ?? [];
  const activeAgentsTarget = sprintCapacityQuery.data?.policy.activeAgentsTarget;
  const tagsLoaded = tagsQuery.isSuccess;

  useEffect(() => {
    const projs = projectsQuery.data;
    if (!projs) return;
    if (projs.length === 0) {
      seededRef.current = false;
      setSeedPending(false);
      setActiveProjectIdState(null);
      return;
    }
    // #327: don't fall back to projs[0] while the active-project preference is
    // still loading — a non-seeded pick is sticky, so racing the preference
    // query dumped users into the wrong project on every reload. Wait until the
    // preference has resolved (success OR error) before choosing.
    if (activeProjectPreferenceQuery.isLoading) return;
    const preferredId = activeProjectPreferenceQuery.data?.projectId;
    const currentIsSeeded = seededRef.current;
    seededRef.current = false;
    setSeedPending(false);
    setActiveProjectIdState((current) =>
      resolveNextActiveProjectId({ current, currentIsSeeded, projects: projs, preferredId }),
    );
  }, [activeProjectPreferenceQuery.isLoading, activeProjectPreferenceQuery.data?.projectId, projectsQuery.data]);

  // Persist the confirmed selection so the next cold load can seed it.
  useEffect(() => {
    if (activeProjectId && !seedPending) persistLastActiveProjectId(activeProjectId);
  }, [activeProjectId, seedPending]);

  useEffect(() => {
    if (projectsQuery.error) setError(projectsQuery.error instanceof Error ? projectsQuery.error.message : "Failed to load projects");
  }, [projectsQuery.error, setError]);

  useEffect(() => {
    // While the optimistic localStorage seed is unconfirmed, hold board errors
    // back: a stale stored id (project deleted since last visit) 404s until the
    // server's active-project answer reconciles it. If the error persists past
    // reconciliation this effect re-runs (seedPending flipped) and surfaces it.
    if (seedPending) return;
    if (boardQuery.error) setError(boardQuery.error instanceof Error ? boardQuery.error.message : "Failed to load board");
  }, [boardQuery.error, seedPending, setError]);

  // One-shot deep-link bootstrap: select the `?issue=<n>` ticket once the board
  // first loads. (The old copy-into-useState effect is gone — react-query owns
  // the columns now, so nothing needs to mirror `boardQuery.data`.)
  useEffect(() => {
    const board = boardQuery.data;
    if (!board) return;
    if (bootstrappedIssueParamRef.current) return;
    bootstrappedIssueParamRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const issueParam = params.get("issue");
    if (issueParam != null) {
      const issueNumber = parseInt(issueParam, 10);
      if (!isNaN(issueNumber)) {
        const found = board.flatMap((c) => c.issues).find((i) => i.issueNumber === issueNumber);
        if (found) boardSelectionActions.setSelectedIssue(found);
      }
    }
  }, [boardQuery.data]);

  const loading =
    projectsQuery.isLoading ||
    activeProjectPreferenceQuery.isLoading ||
    (!!activeProjectId && boardQuery.isLoading && columns.length === 0);

  return {
    activeAgentsTarget,
    activeProjectId,
    allTags,
    archivedProjects,
    columns,
    columnsRef,
    loading,
    milestones,
    projects,
    setActiveProjectId,
    setColumns,
    setSwitchingProject,
    // The skeleton gate: only report "switching" while there is genuinely no
    // board data for the TARGET project. When react-query already holds the
    // target's columns they render immediately and the switch revalidates in
    // the background (no 5s skeleton over data the client already has).
    switchingProject: switchingProject && columns.length === 0,
    tagsLoaded,
  };
}
