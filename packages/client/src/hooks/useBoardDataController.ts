import { useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import { boardSelectionActions } from "../stores/boardSelectionStore.js";
import {
  useActiveProjectPreferenceQuery,
  useArchivedProjectsQuery,
  useBoardQuery,
  useMilestonesQuery,
  useProjectsQuery,
  useSprintCapacityQuery,
  useTagsQuery,
} from "./useBoardDataQueries.js";

interface UseBoardDataControllerParams {
  setError: Dispatch<SetStateAction<string | null>>;
}

export function useBoardDataController({ setError }: UseBoardDataControllerParams) {
  const [columns, setColumns] = useState<StatusWithIssues[]>([]);
  const columnsRef = useRef<StatusWithIssues[]>([]);
  const [switchingProject, setSwitchingProject] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const bootstrappedIssueParamRef = useRef(false);

  const projectsQuery = useProjectsQuery();
  const archivedProjectsQuery = useArchivedProjectsQuery();
  const activeProjectPreferenceQuery = useActiveProjectPreferenceQuery();
  const boardQuery = useBoardQuery(activeProjectId);
  const sprintCapacityQuery = useSprintCapacityQuery(activeProjectId);
  const tagsQuery = useTagsQuery(activeProjectId);
  const milestonesQuery = useMilestonesQuery(activeProjectId);

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

  useEffect(() => {
    const board = boardQuery.data;
    if (!board) return;
    setColumns(board);
    columnsRef.current = board;

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
    columnsRef: columnsRef as MutableRefObject<StatusWithIssues[]>,
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
