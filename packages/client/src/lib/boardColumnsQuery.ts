import type { QueryClient } from "@tanstack/react-query";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import { boardQueryKeys } from "./boardQueryKeys.js";
import { reconcileBoardIssueIdentity } from "./boardDataReconcile.js";

/**
 * Per-project board ETags. Kept module-level (not per-hook) so the SINGLE
 * transport — the react-query query fn below — can send `If-None-Match` no
 * matter which caller triggered the fetch. Cleared on a forced refetch.
 */
const boardEtags = new Map<string, string>();

/** Drop the cached ETag so the next fetch is unconditional (used after a project
 *  switch cleared the columns, where a 304 would otherwise leave the board empty). */
export function clearBoardEtag(projectId: string): void {
  boardEtags.delete(projectId);
}

/** Test-only: reset all cached ETags between cases. */
export function __resetBoardEtags(): void {
  boardEtags.clear();
}

/**
 * ETag-aware conditional GET of a project's board — the ONE board transport,
 * living inside the react-query query fn so the query cache is the single owner
 * of the columns (finding §3.5). It reads the previously cached columns for two
 * purposes: as the 304 fall-back, and as the base for `reconcileBoardIssueIdentity`
 * (reuse unchanged issue refs so `IssueCard.memo` can skip re-render).
 *
 * react-query supplies the concerns the old hand-rolled engine did by hand:
 * in-flight dedupe (one fetch per key) and the out-of-order guard (only the
 * latest fetch's result is committed) — so no sequence counter is needed here.
 */
export async function fetchBoardColumns(
  projectId: string,
  queryClient: QueryClient,
): Promise<StatusWithIssues[]> {
  const prev = queryClient.getQueryData<StatusWithIssues[]>(boardQueryKeys.board(projectId));
  const headers: Record<string, string> = {};
  const cachedEtag = boardEtags.get(projectId);
  // Only send If-None-Match when we have prior columns to fall back to on a 304.
  // Without prior data a 304 would leave the board empty — the exact bug the old
  // `{ force: true }` flag guarded, now handled structurally.
  if (cachedEtag && prev && prev.length > 0) headers["If-None-Match"] = cachedEtag;

  const res = await fetch(`/api/projects/${projectId}/board`, { headers });
  if (res.status === 304) return prev ?? [];
  if (!res.ok) {
    let message = `API error: ${res.status} ${res.statusText}`;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
        message = body.error;
      }
    } catch {}
    throw new Error(message);
  }

  const board = await res.json() as StatusWithIssues[];
  const etag = res.headers.get("ETag");
  if (etag) boardEtags.set(projectId, etag);
  else boardEtags.delete(projectId);
  return reconcileBoardIssueIdentity(prev ?? [], board);
}

/** react-query options for the board query — shared by `useBoardQuery` and the
 *  imperative `refetchBoard` so both use the one ETag-aware transport. */
export function boardColumnsQueryOptions(projectId: string, queryClient: QueryClient) {
  return {
    queryKey: boardQueryKeys.board(projectId),
    queryFn: () => fetchBoardColumns(projectId, queryClient),
  };
}
