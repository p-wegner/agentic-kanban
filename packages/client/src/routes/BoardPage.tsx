import { useCallback, useEffect, useState } from "react";
import { Layout } from "../components/Layout.js";
import { BoardColumn } from "../components/BoardColumn.js";
import { CreateIssueForm } from "../components/CreateIssueForm.js";
import { IssueDetailPanel } from "../components/IssueDetailPanel.js";
import { WorkspacePanel } from "../components/WorkspacePanel.js";
import { apiFetch } from "../lib/api.js";
import type {
  CreateIssueRequest,
  IssueWithStatus,
  StatusWithIssues,
  UpdateIssueRequest,
} from "@agentic-kanban/shared";

interface Project {
  id: string;
  name: string;
}

export function BoardPage() {
  const [columns, setColumns] = useState<StatusWithIssues[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [creatingInColumnId, setCreatingInColumnId] = useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<IssueWithStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const [workspaceIssue, setWorkspaceIssue] = useState<IssueWithStatus | null>(null);
  const [issuesWithWorkspaces, setIssuesWithWorkspaces] = useState<Set<string>>(new Set());

  const refetchBoard = useCallback(async () => {
    const projects = await apiFetch<Project[]>("/api/projects");
    if (projects.length === 0) return;
    const pid = projects[0].id;
    setProjectId(pid);
    const board = await apiFetch<StatusWithIssues[]>(
      `/api/projects/${pid}/board`,
    );
    setColumns(board);
  }, []);

  useEffect(() => {
    async function load() {
      try {
        await refetchBoard();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load board");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [refetchBoard]);

  async function handleCreateIssue(data: CreateIssueRequest) {
    setMutating(true);
    setError(null);
    try {
      await apiFetch("/api/issues", {
        method: "POST",
        body: JSON.stringify(data),
      });
      setCreatingInColumnId(null);
      await refetchBoard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create issue");
    } finally {
      setMutating(false);
    }
  }

  async function handleUpdateIssue(id: string, data: UpdateIssueRequest) {
    setMutating(true);
    setError(null);
    try {
      await apiFetch(`/api/issues/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
      await refetchBoard();
      // Re-find updated issue in new columns
      for (const col of columns) {
        const found = col.issues.find((i) => i.id === id);
        if (found) {
          // We'll get updated data from next render; for now close panel
          break;
        }
      }
      setSelectedIssue(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update issue");
    } finally {
      setMutating(false);
    }
  }

  async function handleDeleteIssue(id: string) {
    setMutating(true);
    setError(null);
    try {
      await apiFetch(`/api/issues/${id}`, { method: "DELETE" });
      setSelectedIssue(null);
      await refetchBoard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete issue");
    } finally {
      setMutating(false);
    }
  }

  function handleDragStart(e: React.DragEvent, issue: IssueWithStatus) {
    e.dataTransfer.setData("application/json", JSON.stringify({
      issueId: issue.id,
      sourceStatusId: issue.statusId,
    }));
    e.dataTransfer.effectAllowed = "move";
  }

  async function handleDrop(targetStatusId: string, sortOrder?: number) {
    try {
      const raw = (window as unknown as Record<string, unknown>).__dragData;
      let issueId: string | undefined;
      let sourceStatusId: string | undefined;

      // Read from dataTransfer wasn't stored, so we use a global bridge
      if (raw && typeof raw === "object") {
        const data = raw as { issueId: string; sourceStatusId: string };
        issueId = data.issueId;
        sourceStatusId = data.sourceStatusId;
      }

      if (!issueId) return;
      if (sourceStatusId === targetStatusId && sortOrder === undefined) return;

      const body: UpdateIssueRequest = { statusId: targetStatusId };
      if (sortOrder !== undefined) body.sortOrder = sortOrder;

      await apiFetch(`/api/issues/${issueId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      await refetchBoard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to move issue");
    }
  }

  function handleIssueClick(issue: IssueWithStatus) {
    setSelectedIssue(issue);
  }

  function handleManageWorkspaces(issue: IssueWithStatus) {
    setSelectedIssue(null);
    setWorkspaceIssue(issue);
  }

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-96 text-gray-500">
          <div className="flex items-center gap-2">
            <svg
              className="animate-spin h-5 w-5 text-gray-400"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            Loading...
          </div>
        </div>
      </Layout>
    );
  }

  // No project found
  if (!projectId) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-96 text-gray-500">
          <div className="text-center">
            <p className="text-lg font-medium text-gray-700 mb-2">
              No project found
            </p>
            <p className="text-sm text-gray-500">
              Run <code className="bg-gray-100 px-1 rounded">pnpm db:seed</code>{" "}
              to create a default project.
            </p>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      {error && (
        <div className="mx-6 mt-4 p-3 bg-red-50 border border-red-200 rounded-md flex items-center justify-between">
          <span className="text-sm text-red-700">{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-600 text-sm"
          >
            Dismiss
          </button>
        </div>
      )}
      {mutating && (
        <div className="fixed top-2 right-2 z-50">
          <div className="bg-blue-50 border border-blue-200 rounded-md px-3 py-1.5 flex items-center gap-2">
            <svg
              className="animate-spin h-3 w-3 text-blue-500"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span className="text-xs text-blue-700">Saving...</span>
          </div>
        </div>
      )}
      <div className="flex gap-4 p-6 overflow-x-auto min-h-[calc(100vh-57px)]">
        {columns.map((col) => (
          <BoardColumn
            key={col.id}
            column={col}
            projectId={projectId}
            creatingInColumn={creatingInColumnId}
            onCreateClick={setCreatingInColumnId}
            onCreateCancel={() => setCreatingInColumnId(null)}
            onIssueClick={handleIssueClick}
            onDragStart={(e, issue) => {
              // Bridge: store drag data on window since onDrop can't read dataTransfer
              (window as unknown as Record<string, unknown>).__dragData = {
                issueId: issue.id,
                sourceStatusId: issue.statusId,
              };
              handleDragStart(e, issue);
            }}
            onDrop={handleDrop}
            issuesWithWorkspaces={issuesWithWorkspaces}
          >
            <CreateIssueForm
              projectId={projectId}
              statusId={col.id}
              onSubmit={handleCreateIssue}
              onCancel={() => setCreatingInColumnId(null)}
            />
          </BoardColumn>
        ))}
      </div>
      {selectedIssue && (
        <IssueDetailPanel
          issue={selectedIssue}
          onUpdate={handleUpdateIssue}
          onDelete={handleDeleteIssue}
          onClose={() => setSelectedIssue(null)}
          onManageWorkspaces={handleManageWorkspaces}
        />
      )}
      {workspaceIssue && (
        <WorkspacePanel
          issue={workspaceIssue}
          onClose={() => setWorkspaceIssue(null)}
          onWorkspaceChange={refetchBoard}
        />
      )}
    </Layout>
  );
}
