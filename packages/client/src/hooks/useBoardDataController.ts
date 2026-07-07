import { useEffect, useMemo, useRef, useState } from "react";
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

interface UseBoardDataControllerParams {
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}

export function useBoardDataController({ setError }: UseBoardDataControllerParams) {
  const queryClient = useQueryClient();
  const [switchingProject, setSwitchingProject] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const bootstrappedIssueParamRef = useRef(false);

  // Single-owner board columns: react-query's `board(projectId)` cache. The
  // legacy `columns` useState mirror and `columnsRef` mirror are gone (§3.5) —
  // `setColumns` / `columnsRef` are a thin facade over the query cache so every
  // consumer keeps its existing call shape while there is only one copy.
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  const { setColumns, columnsRef } = useMemo(
    () => createBoardColumnsStore(queryClient, () => activeProjectIdRef.current),
    [queryClient],
  );

  const projectsQuery = useProjectsQuery();
  const archivedProjectsQuery = useArchivedProjectsQuery();
  const activeProjectPreferenceQuery = useActiveProjectPreferenceQuery();
  const boardQuery = useBoardQuery(activeProjectId);
  const sprintCapacityQuery = useSprintCapacityQuery(activeProjectId);
  const tagsQuery = useTagsQuery(activeProjectId);
  const milestonesQuery = useMilestonesQuery(activeProjectId);

  const columns = boardQuery.data ?? EMPTY_COLUMNS;
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
      setActiveProjectId(null);
      return;
    }
    const preferredId = activeProjectPreferenceQuery.data?.projectId;
    const nextId = preferredId && projs.some((p) => p.id === preferredId) ? preferredId : projs[0].id;
    setActiveProjectId((current) => current ?? nextId);
  }, [activeProjectPreferenceQuery.data?.projectId, projectsQuery.data]);

  useEffect(() => {
    if (projectsQuery.error) setError(projectsQuery.error instanceof Error ? projectsQuery.error.message : "Failed to load projects");
  }, [projectsQuery.error, setError]);

  useEffect(() => {
    if (boardQuery.error) setError(boardQuery.error instanceof Error ? boardQuery.error.message : "Failed to load board");
  }, [boardQuery.error, setError]);

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
    switchingProject,
    tagsLoaded,
  };
}
