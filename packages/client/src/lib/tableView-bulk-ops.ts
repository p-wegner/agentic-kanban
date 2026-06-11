import type { UpdateIssueRequest } from "@agentic-kanban/shared";
import type { Tag } from "../hooks/useBulkOperations.js";

/**
 * Dependencies injected by the component for each bulk operation.
 * `api` / `toast` are parameters (not module imports) so tests can mock them.
 */
export interface BulkOpDeps {
  /** Snapshot of the selected-and-visible issue ids the operation applies to. */
  ids: string[];
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  toast: (message: string, type?: "error" | "success") => void;
  setSelectedIds: (ids: Set<string>) => void;
  setBulkLoading: (loading: boolean) => void;
  onRefresh?: () => void;
}

/** Move all selected issues to a status via the bulk PATCH endpoint. */
export async function bulkMoveStatus(statusId: string, statusName: string, deps: BulkOpDeps): Promise<void> {
  const { ids, api, toast, setSelectedIds, setBulkLoading, onRefresh } = deps;
  setBulkLoading(true);
  try {
    await api("/api/issues/bulk", {
      method: "PATCH",
      body: JSON.stringify({ issueIds: ids, updates: { statusId } }),
    });
    setSelectedIds(new Set());
    toast(`Moved ${ids.length} issue${ids.length !== 1 ? "s" : ""} to "${statusName}"`, "success");
  } catch (err) {
    toast(err instanceof Error ? err.message : "Bulk move failed", "error");
  } finally {
    onRefresh?.();
    setBulkLoading(false);
  }
}

/** Apply a partial update (priority, estimate, due date, ...) to all selected issues. */
export async function bulkUpdateIssues(data: UpdateIssueRequest, successLabel: string, deps: BulkOpDeps): Promise<void> {
  const { ids, api, toast, setSelectedIds, setBulkLoading, onRefresh } = deps;
  setBulkLoading(true);
  try {
    await api("/api/issues/bulk", {
      method: "PATCH",
      body: JSON.stringify({ issueIds: ids, updates: data }),
    });
    setSelectedIds(new Set());
    toast(`${successLabel} for ${ids.length} issue${ids.length !== 1 ? "s" : ""}`, "success");
  } catch (err) {
    toast(err instanceof Error ? err.message : "Bulk update failed", "error");
  } finally {
    onRefresh?.();
    setBulkLoading(false);
  }
}

/** Add a tag to all selected issues (per-issue requests, partial failures reported). */
export async function bulkAddTag(tag: Tag, deps: BulkOpDeps): Promise<void> {
  const { ids, api, toast, setSelectedIds, setBulkLoading, onRefresh } = deps;
  setBulkLoading(true);
  try {
    const results = await Promise.allSettled(ids.map((id) =>
      api(`/api/issues/${id}/tags`, { method: "POST", body: JSON.stringify({ tagId: tag.id }) })
    ));
    const failed = results.filter((r) => r.status === "rejected").length;
    const succeeded = ids.length - failed;
    setSelectedIds(new Set());
    if (failed === 0) {
      toast(`Added tag "${tag.name}" to ${succeeded} issue${succeeded !== 1 ? "s" : ""}`, "success");
    } else {
      toast(`Added tag to ${succeeded} issue${succeeded !== 1 ? "s" : ""}; ${failed} failed`, "error");
    }
  } finally {
    onRefresh?.();
    setBulkLoading(false);
  }
}

/** Remove a tag from all selected issues (per-issue requests, partial failures reported). */
export async function bulkRemoveTag(tag: Tag, deps: BulkOpDeps): Promise<void> {
  const { ids, api, toast, setSelectedIds, setBulkLoading, onRefresh } = deps;
  setBulkLoading(true);
  try {
    const results = await Promise.allSettled(ids.map((id) =>
      api(`/api/issues/${id}/tags/${tag.id}`, { method: "DELETE" })
    ));
    const failed = results.filter((r) => r.status === "rejected").length;
    const succeeded = ids.length - failed;
    setSelectedIds(new Set());
    if (failed === 0) {
      toast(`Removed tag "${tag.name}" from ${succeeded} issue${succeeded !== 1 ? "s" : ""}`, "success");
    } else {
      toast(`Removed tag from ${succeeded} issue${succeeded !== 1 ? "s" : ""}; ${failed} failed`, "error");
    }
  } finally {
    onRefresh?.();
    setBulkLoading(false);
  }
}

/** Delete all selected issues (per-issue requests, partial failures reported). Caller confirms first. */
export async function bulkDeleteIssues(deps: BulkOpDeps): Promise<void> {
  const { ids, api, toast, setSelectedIds, setBulkLoading, onRefresh } = deps;
  setBulkLoading(true);
  try {
    const results = await Promise.allSettled(ids.map((id) =>
      api(`/api/issues/${id}`, { method: "DELETE" })
    ));
    const failed = results.filter((r) => r.status === "rejected").length;
    const succeeded = ids.length - failed;
    setSelectedIds(new Set());
    if (failed === 0) {
      toast(`Deleted ${succeeded} issue${succeeded !== 1 ? "s" : ""}`, "success");
    } else {
      toast(`Deleted ${succeeded} issue${succeeded !== 1 ? "s" : ""}; ${failed} failed to delete`, "error");
    }
  } finally {
    onRefresh?.();
    setBulkLoading(false);
  }
}
